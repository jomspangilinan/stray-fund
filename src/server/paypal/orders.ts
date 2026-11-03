import {
  CheckoutPaymentIntent,
  Client,
  Environment,
  OrdersController,
} from "@paypal/paypal-server-sdk";
import { and, eq, gt, sql } from "drizzle-orm";
import { CURRENCY, MAX_DONATION, MIN_DONATION } from "@/lib/config";
import { fromPayPalValue, toPayPalValue } from "@/lib/money";
import { db, type Tx } from "../db/client";
import { donations } from "../db/schema";
import { e2eFakesEnabled } from "../e2e/guard";
import { fakeOrdersGateway } from "../e2e/paypal";
import { CAPTURED } from "../ledger";
import { enqueueWakeup } from "../wakeups";
import { askIfPoolShort } from "./reversals";

export type Donation = typeof donations.$inferSelect;

export const PENDING = "pending";
const CAPTURE_WAS_COMPLETED = new Set(["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"]);
/** Unfinished orders one user may open in 10 minutes. */
const MAX_PENDING_ORDERS = 5;

type Money = { currency_code?: unknown; value?: unknown };

/** The parts of a PayPal capture we rely on, in PayPal's own field names. */
export type RawCapture = {
  id?: unknown;
  status?: unknown;
  amount?: Money;
  seller_receivable_breakdown?: {
    gross_amount?: Money;
    paypal_fee?: Money;
    net_amount?: Money;
  };
};

/** A capture plus the order it belongs to. The order id comes from outside the capture. */
export type PayPalCapture = RawCapture & { orderId: string };

export class InvalidAmount extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAmount";
  }
}
export class TooManyOrders extends Error {
  constructor() {
    super("Too many unfinished donations. Wait a few minutes and try again.");
    this.name = "TooManyOrders";
  }
}
export class CaptureMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureMismatch";
  }
}
export class UnknownOrder extends Error {
  constructor(readonly orderId: string) {
    super("Capture for an order we have no record of");
    this.name = "UnknownOrder";
  }
}
export class ForbiddenOrder extends Error {
  constructor() {
    super("This order belongs to someone else");
    this.name = "ForbiddenOrder";
  }
}

/** PayPal answered 429. The caller should stop asking for a while. */
export class PayPalRateLimited extends Error {
  constructor() {
    super("PayPal rate limit reached");
    this.name = "PayPalRateLimited";
  }
}

export interface OrdersGateway {
  /**
   * Amount in centavos. Returns the PayPal order id. requestId goes out as PayPal-Request-Id, so repeating the
   * same call with the same id returns the same order instead of making a second one.
   */
  createOrder(amount: number, requestId: string): Promise<{ orderId: string }>;
  /** Returns PayPal's capture response body, parsed. Idempotent per order id. */
  captureOrder(orderId: string): Promise<unknown>;
  /** Returns the order as PayPal holds it (GET /v2/checkout/orders/{id}), parsed. Throws PayPalRateLimited on 429. */
  getOrder(orderId: string): Promise<unknown>;
}

function sdkClient(): OrdersController {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("PayPal credentials are not set");
  return new OrdersController(
    new Client({
      clientCredentialsAuthCredentials: { oAuthClientId: clientId, oAuthClientSecret: clientSecret },
      environment: process.env.PAYPAL_ENV === "production" ? Environment.Production : Environment.Sandbox,
      timeout: 30_000,
    }),
  );
}

export const sdkOrdersGateway: OrdersGateway = {
  async createOrder(amount, requestId) {
    const res = await sdkClient().createOrder({
      paypalRequestId: requestId,
      body: {
        intent: CheckoutPaymentIntent.Capture,
        purchaseUnits: [
          {
            amount: { currencyCode: CURRENCY, value: toPayPalValue(amount) },
            description: "Donation to Stray Fund",
          },
        ],
      },
    });
    const orderId = res.result.id;
    if (!orderId) throw new Error("PayPal returned no order id");
    return { orderId };
  },
  async captureOrder(orderId) {
    const res = await sdkClient().captureOrder({ id: orderId, paypalRequestId: `capture-${orderId}` });
    return JSON.parse(String(res.body)) as unknown;
  },
  async getOrder(orderId) {
    try {
      const res = await sdkClient().getOrder({ id: orderId });
      return JSON.parse(String(res.body)) as unknown;
    } catch (e) {
      if ((e as { statusCode?: unknown })?.statusCode === 429) throw new PayPalRateLimited();
      throw e;
    }
  },
};

/** The real PayPal gateway, or the end-to-end test's fake. Production cannot reach the fake. */
export function ordersGateway(): OrdersGateway {
  return e2eFakesEnabled() ? fakeOrdersGateway : sdkOrdersGateway;
}

export function validateDonationAmount(amount: unknown): number {
  if (typeof amount !== "number" || !Number.isSafeInteger(amount)) {
    throw new InvalidAmount("Amount must be a whole number of centavos");
  }
  if (amount < MIN_DONATION) throw new InvalidAmount("Amount is below the minimum donation");
  if (amount > MAX_DONATION) throw new InvalidAmount("Amount is above the maximum donation");
  return amount;
}

const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidAttempt extends Error {
  constructor() {
    super("The donation attempt id is missing or not valid");
    this.name = "InvalidAttempt";
  }
}

/**
 * The PayPal-Request-Id for one donation attempt. The page makes a new attempt id for each tap and reuses it only
 * for a retry of that tap, so a retry gets the same order back and a new tap gets a new one. The donor and the
 * amount are part of the key, so another donor, or the same donor changing the amount, can never be handed this
 * order. PayPal keeps an order-create key for 6 hours (the Orders v2 spec); an order also lapses after about 6
 * hours unapproved, and a retry comes seconds later, so the window is never what decides it.
 */
export function orderRequestId(userId: string, attemptId: string, gross: number): string {
  return `stray-order-${userId}-${attemptId.toLowerCase()}-${gross}`;
}

/**
 * Creates the PayPal order, then a pending row owned by the donor. Fee and net stay 0 until capture. Safe to
 * repeat with the same attemptId: PayPal returns the same order and the row is written once.
 */
export async function createDonationOrder(
  userId: string,
  amount: unknown,
  attemptId: unknown,
  gw: OrdersGateway = ordersGateway(),
): Promise<{ orderId: string }> {
  const gross = validateDonationAmount(amount);
  if (typeof attemptId !== "string" || !ATTEMPT_ID.test(attemptId)) throw new InvalidAttempt();
  const recent = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(donations)
    .where(
      and(
        eq(donations.userId, userId),
        eq(donations.status, PENDING),
        gt(donations.createdAt, sql`now() - interval '10 minutes'`),
      ),
    );
  if (recent[0].n >= MAX_PENDING_ORDERS) throw new TooManyOrders();
  const { orderId } = await gw.createOrder(gross, orderRequestId(userId, attemptId, gross));
  await db
    .insert(donations)
    .values({
      userId,
      gross,
      paypalFee: 0,
      net: 0,
      currency: CURRENCY,
      paypalOrderId: orderId,
      status: PENDING,
    })
    .onConflictDoNothing({ target: donations.paypalOrderId });
  const [row] = await db.select().from(donations).where(eq(donations.paypalOrderId, orderId));
  // The key holds the donor, so this is the retry of our own order. Anything else is not ours to hand back.
  if (row.userId !== userId) throw new Error("PayPal returned an order that belongs to someone else");
  return { orderId };
}

function money(m: Money | undefined, what: string): number {
  if (!m || m.currency_code !== CURRENCY || typeof m.value !== "string") {
    throw new CaptureMismatch(`${what} is missing or not in ${CURRENCY}`);
  }
  try {
    return fromPayPalValue(m.value);
  } catch {
    throw new CaptureMismatch(`${what} is not a valid amount`);
  }
}

/** Picks the capture out of an order-capture response. */
export function captureFromOrder(body: unknown): PayPalCapture {
  const order = body as {
    id?: unknown;
    purchase_units?: { payments?: { captures?: RawCapture[] } }[];
  };
  const capture = order?.purchase_units?.[0]?.payments?.captures?.[0];
  if (typeof order?.id !== "string" || !capture) {
    throw new CaptureMismatch("Capture response had no capture");
  }
  return { ...capture, orderId: order.id };
}

/**
 * The single idempotent writer for the capture response and the webhook. Fee and
 * net come only from seller_receivable_breakdown and must add up to gross. Only the
 * first writer flips the row to captured and queues the wakeup. Pass tx to join a
 * caller's transaction (the webhook does, so dedupe and effect commit together).
 */
export async function recordCapture(capture: PayPalCapture, tx?: Tx): Promise<Donation> {
  if (!tx) return db.transaction((t) => recordCapture(capture, t));

  const [row] = await tx.select().from(donations).where(eq(donations.paypalOrderId, capture.orderId));
  if (!row) throw new UnknownOrder(capture.orderId);
  // Not COMPLETED (pending review, declined): nothing is captured yet. A capture already refunded, in part or whole,
  // was completed first; the poller can meet one when it was never recorded, and its refunds are separate rows.
  if (!CAPTURE_WAS_COMPLETED.has(String(capture.status))) return row;

  if (typeof capture.id !== "string" || !capture.id) throw new CaptureMismatch("Capture has no id");
  const b = capture.seller_receivable_breakdown;
  const gross = money(b?.gross_amount, "gross_amount");
  const fee = money(b?.paypal_fee, "paypal_fee");
  const net = money(b?.net_amount, "net_amount");
  if (gross !== fee + net) {
    throw new CaptureMismatch(`gross ${gross} is not fee ${fee} plus net ${net}`);
  }
  if (gross !== row.gross) {
    throw new CaptureMismatch(`captured ${gross} but the order was for ${row.gross}`);
  }

  // The conditional update is the atomic first-write test: a concurrent writer
  // waits on this row, then sees it is no longer pending.
  const [first] = await tx
    .update(donations)
    .set({ status: CAPTURED, paypalFee: fee, net, paypalCaptureId: capture.id })
    .where(and(eq(donations.id, row.id), eq(donations.status, PENDING)))
    .returning();
  if (!first) {
    const [current] = await tx.select().from(donations).where(eq(donations.id, row.id));
    if (current.paypalCaptureId && current.paypalCaptureId !== capture.id) {
      console.error(`Order ${capture.orderId} already has capture ${current.paypalCaptureId}, ignoring ${capture.id}`);
    }
    return current;
  }
  await enqueueWakeup(tx, "donation_captured", {
    donationId: first.id,
    userId: first.userId,
    gross: first.gross,
    net: first.net,
  });
  // A refund can arrive before its capture. Now that it counts, the pool may be short.
  await askIfPoolShort(tx, first.id);
  return first;
}

/** Captures the donor's own order at PayPal, then records it. 403 for another user's order. */
export async function captureDonation(
  userId: string,
  orderId: string,
  gw: OrdersGateway = ordersGateway(),
): Promise<Donation> {
  const [row] = await db.select().from(donations).where(eq(donations.paypalOrderId, orderId));
  if (!row) throw new UnknownOrder(orderId);
  if (row.userId !== userId) throw new ForbiddenOrder();
  if (row.status !== PENDING) return row;

  let body: unknown;
  try {
    body = await gw.captureOrder(orderId);
  } catch (e) {
    // The webhook may have won the race and PayPal refuses a second capture.
    const [again] = await db.select().from(donations).where(eq(donations.paypalOrderId, orderId));
    if (again?.status === CAPTURED) return again;
    throw e;
  }
  return recordCapture(captureFromOrder(body));
}
