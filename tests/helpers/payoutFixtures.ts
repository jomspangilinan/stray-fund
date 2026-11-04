import { sql } from "drizzle-orm";
import { db } from "../../src/server/db/client";
import {
  agentActions,
  allocations,
  allowedPayees,
  bookings,
  cats,
  donations,
  guardrails,
  payouts,
  receipts,
  users,
} from "../../src/server/db/schema";
import { approvePayout, requestPayout, type PayoutRequest } from "../../src/server/moneyGate";
import type { PayoutGateway } from "../../src/server/paypal/payouts";

let seq = 0;
const next = () => `${Date.now()}-${++seq}`;

export async function makeVet(opts: { allowed?: boolean; email?: string | null } = {}) {
  const n = next();
  const [vet] = await db
    .insert(users)
    .values({
      username: `vet-${n}`,
      role: "vet",
      paypalEmail: opts.email === undefined ? `vet-${n}@example.test` : opts.email,
    })
    .returning();
  if (opts.allowed ?? true) {
    await db.insert(allowedPayees).values({ userId: vet.id, kind: "vet" });
  }
  return vet;
}

export async function makeCaretaker() {
  const [user] = await db
    .insert(users)
    .values({ username: `care-${next()}`, role: "caretaker" })
    .returning();
  return user;
}

/** Captures a donation and allocates all of its net to the cat. */
export async function fundCat(catId: string, amount: number, status = "captured") {
  const [donation] = await db
    .insert(donations)
    .values({ gross: amount, net: amount, paypalOrderId: `order-${next()}`, status })
    .returning();
  await db
    .insert(allocations)
    .values({ donationId: donation.id, catId, purpose: "vet", amount });
  return donation;
}

export async function makeBooking(catId: string, vetId: string, status = "confirmed") {
  const [booking] = await db
    .insert(bookings)
    .values({ catId, vetId, packagePrice: 150000, status })
    .returning();
  return booking;
}

/** A confirmed booking for a funded cat with an allowed, payable vet. */
export async function makeWorld(opts: { funded?: number } = {}) {
  const vet = await makeVet();
  const [cat] = await db
    .insert(cats)
    .values({ name: `Cat ${next()}`, areaName: "Brgy 1" })
    .returning();
  await fundCat(cat.id, opts.funded ?? 250000);
  const booking = await makeBooking(cat.id, vet.id);
  return { vet, cat, booking };
}

export type World = Awaited<ReturnType<typeof makeWorld>>;

export function depositRequest(w: World, amount = 45000) {
  return {
    catId: w.cat.id,
    payeeId: w.vet.id,
    bookingId: w.booking.id,
    amount,
    kind: "deposit" as const,
  };
}

export async function addReceipt(bookingId: string, verification = "verified") {
  const [receipt] = await db
    .insert(receipts)
    .values({ bookingId, fileKey: "k", sha256: `sha-${next()}`, verification })
    .returning();
  // A verified receipt always comes with a confirmed ear-tip, as in applyEvidence.
  if (verification === "verified") {
    await db.execute(sql`
      update cats set ear_tipped = true where id = (select cat_id from bookings where id = ${bookingId})
    `);
  }
  return receipt;
}

/** Inserts a payout row directly, bypassing the gate. */
export async function addPayout(
  w: Pick<World, "cat" | "vet"> & { booking: { id: string } },
  fields: {
    amount: number;
    status: string;
    kind?: "deposit" | "balance";
    createdAt?: Date;
    batchId?: string;
    attempts?: number;
    lastAttemptAt?: Date;
    itemStatus?: string;
    lastGatewayError?: string;
  },
) {
  const [action] = await db
    .insert(agentActions)
    .values({ action: "payout", reason: "fixture", status: fields.status })
    .returning();
  const [payout] = await db
    .insert(payouts)
    .values({
      catId: w.cat.id,
      bookingId: w.booking.id,
      payeeUserId: w.vet.id,
      amount: fields.amount,
      kind: fields.kind ?? "deposit",
      actionId: action.id,
      status: fields.status,
      paypalPayoutBatchId: fields.batchId,
      attempts: fields.attempts ?? 0,
      lastAttemptAt: fields.lastAttemptAt,
      paypalItemStatus: fields.itemStatus,
      lastGatewayError: fields.lastGatewayError,
      ...(fields.createdAt ? { createdAt: fields.createdAt } : {}),
    })
    .returning();
  return payout;
}

export async function setGuardrails(values: Partial<typeof guardrails.$inferInsert>) {
  await db.update(guardrails).set(values);
}

/** Makes every queued payout look older than the retry window. */
export async function ageQueuedPayouts() {
  await db.execute(sql`
    update payouts set
      created_at = now() - interval '1 hour',
      last_attempt_at = case when last_attempt_at is null then null
                             else now() - interval '1 minute' end
    where status = 'queued'
  `);
}

type CreateInput = Parameters<PayoutGateway["create"]>[0];
type CreateResult = Awaited<ReturnType<PayoutGateway["create"]>>;
type GetResult = Awaited<ReturnType<PayoutGateway["get"]>>;

/** Records calls. Results queue up; once empty, create reports a sent batch. */
export class FakeGateway implements PayoutGateway {
  calls: CreateInput[] = [];
  results: (CreateResult | Error)[] = [];
  statuses = new Map<string, GetResult | Error>();
  onCreate?: (i: CreateInput) => Promise<void>;

  constructor(results: (CreateResult | Error)[] = []) {
    this.results = results;
  }

  async create(i: CreateInput): Promise<CreateResult> {
    this.calls.push(i);
    if (this.onCreate) await this.onCreate(i);
    const result = this.results.shift();
    if (result instanceof Error) throw result;
    return result ?? { kind: "sent", batchId: `batch-${i.senderBatchId}`, status: "PENDING" };
  }

  async get(batchId: string): Promise<GetResult> {
    const status = this.statuses.get(batchId);
    if (status instanceof Error) throw status;
    return status ?? { batchStatus: "PROCESSING" };
  }
}

/**
 * Asks for a payout the way the agent does, and when the gate holds it for a caretaker,
 * has one approve it, so a test about what happens after the send still gets a sent payout.
 * A payout the gate did not hold for approval, or one it kept waiting for a reason, comes back as it was.
 */
export async function requestAndApprove(r: PayoutRequest, gw: PayoutGateway) {
  const asked = await requestPayout(r, gw);
  if (asked.status !== "awaiting_approval" || asked.code || !asked.payoutId) return asked;
  const caretaker = await makeCaretaker();
  return approvePayout(asked.payoutId, caretaker.id, gw);
}
