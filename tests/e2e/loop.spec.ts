import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { Db, fakePayPalCalls, PAYPAL_HEADERS, payoutEvent, pickRole, receiptImage, signInAs } from "./helpers";

/*
 * The whole story, once, against the real app: a neighbour spots a cat, two neighbours agree it is not yet
 * neutered, donors give, the treasurer funds it, a vet books and is paid a deposit a caretaker approves,
 * sends a receipt and a photo, a caretaker confirms the ear-tip, the balance is approved and paid, and every
 * peso adds up. Only PayPal and the AI are fake (E2E_FAKES). The database, the money gate, the guardrails,
 * the ledger, the worker and every page are the real ones. All money below is in centavos.
 */

const PACKAGE = 150_000;
const DEPOSIT = 45_000; // 30% of the package
const RECEIPT_TOTAL = 120_000; // a receipt for PHP 1,200, so the cat's package comes in under budget
const BALANCE = RECEIPT_TOTAL - DEPOSIT;
const SURPLUS = PACKAGE - RECEIPT_TOTAL;
const DONATION_1 = { gross: 150_000, fee: 5_850 }; // 2.9% + PHP 15.00 in the fake
const DONATION_2 = { gross: 50_000, fee: 2_950 };
const DEPOSIT_FEE = 900;
const BALANCE_FEE = 1_500;
// The invented place every photo is taken at (playwright.config.ts).
/** The coordinate rounded to 3, 4, 5 and 6 decimals, plus the full value, so a leak at any precision above 2 is caught. */
function coordinateForms(value: number): string[] {
  return [...new Set([String(value), ...[3, 4, 5, 6].map((d) => value.toFixed(d))])];
}

const EXACT = { lat: "10.4321", lng: "120.8765" };

const fakeSdk = readFileSync(path.join(__dirname, "fake-paypal-sdk.js"), "utf8");
const peso = (c: number) => `₱${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

let db: Db;
test.beforeAll(() => {
  db = new Db();
});
test.afterAll(async () => {
  await db.close();
});

async function catRow(id: string) {
  return db.one<{ status: string; ear_tipped: boolean | null; neutered_unconfirmed: boolean; name: string }>(
    "select status, ear_tipped, neutered_unconfirmed, name from cats where id = $1",
    [id],
  );
}

async function donate(page: Page, username: string, preset: string, gross: number, fee: number) {
  await signInAs(page, username);
  await page.goto("/donate");
  await page.getByRole("radio", { name: preset, exact: true }).click();
  await page.getByTestId("fake-paypal").click();
  const thanks = page.getByRole("status").filter({ hasText: `Thank you, ${username}` });
  await expect(thanks).toBeVisible();
  await expect(thanks).toContainText(`You gave${peso(gross)}`);
  await expect(thanks).toContainText(`PayPal fee${peso(fee)}`);
  await expect(thanks).toContainText(`Reached the fund${peso(gross - fee)}`);
}

async function wakeupsSettled() {
  await expect
    .poll(async () => (await db.one<{ n: number }>("select count(*)::int as n from wakeups where status in ('pending','running')")).n, { timeout: 60_000 })
    .toBe(0);
}

/** The caretaker's desk: opens the item for this heading and approves it through the Send step. */
async function approveOnDesk(page: Page, heading: string, question: string) {
  await pickRole(page, "Caretaker");
  await page.goto("/caretaker");
  const item = page.getByRole("listitem").filter({ hasText: heading });
  await item.getByRole("button", { name: "Approve and send" }).click();
  await expect(item.getByText(question)).toBeVisible();
  await item.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(/^Approved\. The payment is sent/)).toBeVisible();
}

async function paypalConfirms(page: Page, payoutId: string, fee: string, eventId: string) {
  const p = await db.one<{ paypal_payout_batch_id: string }>("select paypal_payout_batch_id from payouts where id = $1", [payoutId]);
  const res = await page.request.post("/api/webhooks/paypal", {
    headers: PAYPAL_HEADERS,
    data: payoutEvent(eventId, { batchId: p.paypal_payout_batch_id, senderBatchId: payoutId, fee }),
  });
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ result: "processed" });
}

test("a stray cat is spotted, funded, neutered and paid for, and every peso adds up", async ({ page, context }) => {
  await context.route("**/sdk/js**", (route) => route.fulfill({ contentType: "application/javascript", body: fakeSdk }));

  // ---------------------------------------------------------------- the rules
  await test.step("the caretaker sets the rule that sends money to a person: anything over PHP 400 needs approval", async () => {
    await page.goto("/");
    await pickRole(page, "Caretaker");
    await page.goto("/caretaker/rules");
    await page.getByLabel("Approval threshold").fill("400");
    await page.getByRole("button", { name: "Save rules" }).click();
    await expect(page.getByText(/^Saved\. The new rules apply/)).toBeVisible();
    const g = await db.one<{ package_price: number; deposit_pct: number; approval_threshold: number }>("select * from guardrails");
    expect(g).toMatchObject({ package_price: PACKAGE, deposit_pct: 30, approval_threshold: 40_000 });
  });

  // ---------------------------------------------------------------- spot
  let catId = "";
  await test.step("a neighbour takes a photo first, with no questions in the way, and a new card starts", async () => {
    await signInAs(page, "e2e_finder");
    await page.goto("/spot");
    await page.getByRole("button", { name: "Open camera" }).click();
    const shutter = page.getByRole("button", { name: "Take photo" });
    await expect(shutter).toBeEnabled();
    await expect(page.getByText("Tipped ear?")).toHaveCount(0);
    await expect(page.getByText("Girl or boy?")).toHaveCount(0);
    await shutter.click();
    await expect(page.getByRole("heading", { name: "New cat spotted!" })).toBeVisible();
    await expect(page.getByText("Mocha", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "See the card" }).first().click();
    await page.waitForURL(/\/cats\/[0-9a-f-]{36}$/);
    catId = page.url().split("/").pop()!;

    const sighting = await db.one<{ state: string; public_ready: boolean; exact_lat: number; exact_lng: number }>(
      "select state, public_ready, exact_lat, exact_lng from sightings where cat_id = $1",
      [catId],
    );
    expect(sighting.state).toBe("new_cat");
    expect(sighting.public_ready).toBe(true);
    // The finder's phone sent the exact place, and the server keeps it private.
    expect([String(sighting.exact_lat), String(sighting.exact_lng)]).toEqual([EXACT.lat, EXACT.lng]);
    expect(await catRow(catId)).toMatchObject({ status: "spotted", name: "Mocha" });
  });

  await test.step("two neighbours say there is no ear-tip, so the cat joins the queue", async () => {
    // The finder answers on the card, optional and after the photo.
    await page.getByRole("radio", { name: "No", exact: true }).click();
    await expect(page.getByText("Saved. Thanks.")).toBeVisible();
    expect((await catRow(catId)).status).toBe("spotted");

    await signInAs(page, "e2e_neighbour");
    await page.goto(`/cats/${catId}`);
    await page.getByRole("radio", { name: "No", exact: true }).click();
    await expect(page.getByText("Saved. Thanks.")).toBeVisible();
    await expect.poll(async () => (await catRow(catId)).status).toBe("queued");
    expect(await catRow(catId)).toMatchObject({ ear_tipped: false, neutered_unconfirmed: false });
    await page.reload();
    await expect(page.getByText("Waiting for funding").first()).toBeVisible();
    await wakeupsSettled();
  });

  // ---------------------------------------------------------------- donate
  await test.step("a donor gives PHP 1,500: too little to cover the package after PayPal's fee, so the treasurer waits", async () => {
    await donate(page, "e2e_donor", "₱1,500", DONATION_1.gross, DONATION_1.fee);
    await wakeupsSettled();
    expect((await catRow(catId)).status).toBe("queued");
    const pool = await (await page.request.get("/api/impact")).json();
    expect(pool.pool).toMatchObject({ grossIn: 150_000, paypalFees: DONATION_1.fee, available: DONATION_1.gross - DONATION_1.fee, heldForCats: 0 });
    expect(DONATION_1.gross - DONATION_1.fee).toBeLessThan(PACKAGE);

    // The fake treasurer asked for the funding anyway. The real tool must have said no, so this proves the rule.
    const asked = fakePayPalCalls().filter((c) => c.call === "treasurer.fund_next_cat");
    expect(asked.length).toBeGreaterThan(0);
    for (const a of asked) expect(a).toMatchObject({ ok: false, code: "INSUFFICIENT_FUNDS" });
    expect(await db.one("select count(*)::int as n from allocations where cat_id = $1", [catId])).toMatchObject({ n: 0 });
    expect(await db.one("select count(*)::int as n from agent_actions where action = 'fund_cat'")).toMatchObject({ n: 0 });
  });

  await test.step("a second donor gives PHP 500 and the treasurer funds the cat through its real tools", async () => {
    await donate(page, "e2e_donor2", "₱500", DONATION_2.gross, DONATION_2.fee);
    await expect.poll(async () => (await catRow(catId)).status, { timeout: 60_000 }).toBe("funded");
    await wakeupsSettled();

    const action = await db.one<{ action: string; amount: number; status: string; reason: string }>(
      "select action, amount, status, reason from agent_actions where action = 'fund_cat'",
    );
    expect(action).toMatchObject({ amount: PACKAGE, status: "done" });
    expect(action.reason).toContain("Mocha");
    const allocations = await db.rows<{ gross: number; amount: number }>(
      "select d.gross, a.amount from allocations a join donations d on d.id = a.donation_id where a.cat_id = $1 order by d.created_at",
      [catId],
    );
    // First in, first out: the first donation's whole net is used, then the rest comes from the second.
    expect(allocations.map((a) => [Number(a.gross), Number(a.amount)])).toEqual([
      [DONATION_1.gross, DONATION_1.gross - DONATION_1.fee],
      [DONATION_2.gross, PACKAGE - (DONATION_1.gross - DONATION_1.fee)],
    ]);
    const pool = (await (await page.request.get("/api/impact")).json()).pool;
    const netIn = DONATION_1.gross + DONATION_2.gross - DONATION_1.fee - DONATION_2.fee;
    expect(pool).toMatchObject({ heldForCats: PACKAGE, available: netIn - PACKAGE });
  });

  // ---------------------------------------------------------------- the vet
  let bookingId = "";
  await test.step("the vet books the funded cat and the treasurer asks a caretaker to approve the 30% deposit", async () => {
    await page.goto("/");
    await pickRole(page, "Vet");
    await page.waitForURL("**/vet");
    await expect(page.getByRole("heading", { name: "Mocha" })).toBeVisible();
    await page.getByRole("button", { name: "Book Mocha" }).click();
    await page.waitForURL(/\/vet\/bookings\//);
    bookingId = page.url().split("/").pop()!;
    await expect.poll(async () => (await db.rows("select 1 from payouts where booking_id = $1 and kind = 'deposit'", [bookingId])).length, { timeout: 60_000 }).toBe(1);
    const deposit = await db.one<{ amount: number; status: string; fee: number | null }>("select amount, status, fee from payouts where booking_id = $1 and kind = 'deposit'", [bookingId]);
    expect(deposit).toMatchObject({ amount: DEPOSIT, status: "awaiting_approval", fee: null });
    // Nothing has left yet: PayPal has not been called for a payout.
    expect(fakePayPalCalls().filter((c) => c.call === "payout.create")).toHaveLength(0);
    await page.reload();
    await expect(page.getByText("Waiting for a caretaker").first()).toBeVisible();
    await expect(page.getByText("The form opens once the first payment has reached you.")).toBeVisible();
    expect((await catRow(catId)).status).toBe("booked");
    await wakeupsSettled();
  });

  let depositId = "";
  await test.step("the caretaker approves the deposit at the Send step, and PayPal is called once", async () => {
    await approveOnDesk(page, "Deposit for Mocha", `Send ₱450 to demo_vet? This can't be undone.`);
    const deposit = await db.one<{ id: string; status: string; attempts: number; paypal_payout_batch_id: string }>(
      "select id, status, attempts, paypal_payout_batch_id from payouts where booking_id = $1 and kind = 'deposit'",
      [bookingId],
    );
    depositId = deposit.id;
    expect(deposit).toMatchObject({ status: "sent", attempts: 1 });
    const creates = fakePayPalCalls().filter((c) => c.call === "payout.create");
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({ senderBatchId: depositId, amount: DEPOSIT, receiver: "demo-vet@e2e.invalid" });
  });

  await test.step("PayPal reports the deposit paid: the fee is recorded, the cat is in care, a replay changes nothing", async () => {
    await paypalConfirms(page, depositId, "9.00", "E2E-EVENT-DEPOSIT");
    const replay = await page.request.post("/api/webhooks/paypal", {
      headers: PAYPAL_HEADERS,
      data: payoutEvent("E2E-EVENT-DEPOSIT", { batchId: "ignored", senderBatchId: depositId, fee: "9.00" }),
    });
    expect(await replay.json()).toEqual({ result: "duplicate" });
    const forged = await page.request.post("/api/webhooks/paypal", {
      headers: { ...PAYPAL_HEADERS, "paypal-transmission-sig": "forged" },
      data: payoutEvent("E2E-EVENT-FORGED", { batchId: "x", senderBatchId: depositId, fee: "0.00" }),
    });
    expect(forged.status()).toBe(400);
    await expect.poll(async () => (await catRow(catId)).status, { timeout: 60_000 }).toBe("in_care");
    expect(await db.one("select status, fee from payouts where id = $1", [depositId])).toMatchObject({ status: "succeeded", fee: DEPOSIT_FEE });
    await wakeupsSettled();
  });

  await test.step("the vet sends a receipt and a live photo; the checks pass and a caretaker is asked to look at the ear", async () => {
    await pickRole(page, "Vet");
    await page.goto(`/vet/bookings/${bookingId}`);
    await expect(page.getByText("PayPal reference:").first()).toBeVisible();
    await page.getByLabel("Photo of the receipt").setInputFiles({ name: "receipt.jpg", mimeType: "image/jpeg", buffer: await receiptImage(RECEIPT_TOTAL / 100) });
    await page.getByRole("button", { name: "Open camera" }).click();
    await page.getByRole("button", { name: "Take photo" }).click();
    await expect(page.getByText("Photo taken.")).toBeVisible();
    await page.getByRole("button", { name: "Send for checking" }).click();
    await expect(page.getByText("Waiting for a caretaker. You do not need to send anything again.")).toBeVisible();
    const receipt = await db.one<{ verification: string; parsed: { total_centavos: number; clinic: string } }>("select verification, parsed from receipts where booking_id = $1", [bookingId]);
    expect(receipt.verification).toBe("awaiting_ear_tip_confirmation");
    expect(receipt.parsed.total_centavos).toBe(RECEIPT_TOTAL);
    // Nothing has been released or counted: the cat is not neutered until a person has seen the ear.
    expect((await catRow(catId)).status).toBe("in_care");
    expect(await db.rows("select 1 from payouts where booking_id = $1 and kind = 'balance'", [bookingId])).toHaveLength(0);
    expect(await db.rows("select 1 from treatments where cat_id = $1", [catId])).toHaveLength(0);
  });

  await test.step("the caretaker sees the ear-tip in the vet's photo; the cat is neutered, the surplus returns, and the balance waits for approval", async () => {
    await pickRole(page, "Caretaker");
    await page.goto("/caretaker");
    const item = page.getByRole("listitem").filter({ hasText: "The receipt passed every check" });
    await expect(item.getByRole("img", { name: "The vet's photo of the cat after surgery" })).toBeVisible();
    await item.getByRole("button", { name: "I saw the ear-tip in the photo" }).click();
    await expect(page.getByText(/^Confirmed\. The cat is marked neutered/)).toBeVisible();

    expect(await catRow(catId)).toMatchObject({ status: "neutered", ear_tipped: true, neutered_unconfirmed: false });
    expect(await db.rows("select type from treatments where cat_id = $1 order by type", [catId])).toEqual([{ type: "deworming" }, { type: "neuter" }, { type: "vaccine" }]);
    const returned = await db.one<{ amount: number }>("select sum(amount)::int as amount from allocations where cat_id = $1 and amount < 0", [catId]);
    expect(Number(returned.amount)).toBe(-SURPLUS);

    await expect.poll(async () => (await db.rows("select 1 from payouts where booking_id = $1 and kind = 'balance'", [bookingId])).length, { timeout: 60_000 }).toBe(1);
    const balance = await db.one<{ amount: number; status: string }>("select amount, status from payouts where booking_id = $1 and kind = 'balance'", [bookingId]);
    expect(balance).toMatchObject({ amount: BALANCE, status: "awaiting_approval" });
    await wakeupsSettled();
  });

  let balanceId = "";
  await test.step("the caretaker approves the balance and PayPal confirms it", async () => {
    await approveOnDesk(page, "Balance for Mocha", `Send ₱750 to demo_vet? This can't be undone.`);
    const balance = await db.one<{ id: string }>("select id from payouts where booking_id = $1 and kind = 'balance'", [bookingId]);
    balanceId = balance.id;
    await paypalConfirms(page, balanceId, "15.00", "E2E-EVENT-BALANCE");
    await expect.poll(async () => (await db.one<{ status: string }>("select status from bookings where id = $1", [bookingId])).status, { timeout: 60_000 }).toBe("completed");
    await wakeupsSettled();
  });

  // ---------------------------------------------------------------- the money adds up
  await test.step("no payment was repeated: two payouts, two PayPal calls, and approving again sends nothing", async () => {
    for (const id of [depositId, balanceId]) {
      const again = await page.request.post("/api/caretaker/payout_approve", { data: { payoutId: id } });
      expect((await again.json()).message).toMatch(/^Approved\. The payment is paid\./);
    }
    const payouts = await db.rows<{ kind: string; amount: number; status: string; fee: number; attempts: number }>("select kind, amount, status, fee, attempts from payouts order by created_at");
    expect(payouts).toEqual([
      { kind: "deposit", amount: DEPOSIT, status: "succeeded", fee: DEPOSIT_FEE, attempts: 1 },
      { kind: "balance", amount: BALANCE, status: "succeeded", fee: BALANCE_FEE, attempts: 1 },
    ]);
    const creates = fakePayPalCalls().filter((c) => c.call === "payout.create");
    expect(creates.map((c) => [c.senderBatchId, c.amount])).toEqual([[depositId, DEPOSIT], [balanceId, BALANCE]]);
    expect(new Set(creates.map((c) => c.senderBatchId)).size).toBe(2);
    expect(await db.rows("select 1 from agent_actions where action in ('payout_deposit','payout_balance')")).toHaveLength(2);
  });

  await test.step("the ledger and the Proof page add up to the centavo", async () => {
    const snapshot = await (await page.request.get("/api/ledger")).json();
    const grossIn = DONATION_1.gross + DONATION_2.gross;
    const fees = DONATION_1.fee + DONATION_2.fee;
    const vetPaid = DEPOSIT + BALANCE;
    const payoutFees = DEPOSIT_FEE + BALANCE_FEE;
    const held = PACKAGE - SURPLUS - vetPaid; // allocated to the cat, minus what the vet has been paid
    const left = grossIn - fees - (PACKAGE - SURPLUS) - payoutFees;
    expect(snapshot.pool).toEqual({ grossIn, paypalFees: fees, vetPaid, payoutFees, heldForCats: held, reservedPayouts: 0, available: left, reversedGross: 0 });
    expect(held).toBe(0);
    expect(grossIn).toBe(fees + vetPaid + payoutFees + held + left);

    type Row = { type: string; amount: number; fee: number | null; status: string; paypalId: string | null; cat: string | null };
    const rows: Row[] = snapshot.rows;
    const view = (type: string) => rows.filter((r) => r.type === type).map((r) => [r.amount, r.fee, r.status]).sort();
    expect(view("donation")).toEqual([[DONATION_2.gross, DONATION_2.fee, "captured"], [DONATION_1.gross, DONATION_1.fee, "captured"]].sort());
    expect(view("vet_deposit")).toEqual([[DEPOSIT, DEPOSIT_FEE, "succeeded"]]);
    expect(view("vet_balance")).toEqual([[BALANCE, BALANCE_FEE, "succeeded"]]);
    // Fake ids are plain about being fake.
    expect(rows.every((r) => r.paypalId?.startsWith("E2E-"))).toBe(true);
    expect(rows.reduce((s, r) => s + (r.type === "donation" ? r.amount : 0), 0)).toBe(grossIn);

    await page.goto("/impact");
    await expect(page.getByText("This adds up exactly, across every donation and payout.")).toBeVisible();
    await expect(page.getByText(`Donated ${peso(grossIn)} = PayPal fees ${peso(fees)} + paid to vets ${peso(vetPaid)} + payout fees ${peso(payoutFees)} + set aside for cats ${peso(held)} + still free ${peso(left)}`)).toBeVisible();
    await expect(page.getByRole("term").filter({ hasText: "Cats fixed" }).locator("xpath=following-sibling::dd[1]")).toHaveText("1");
    await page.goto("/ledger");
    await expect(page.getByRole("heading", { name: "Money" })).toBeVisible();
  });

  await test.step("Helped shows the cat to the people whose money stayed with it, and Cats shows it neutered", async () => {
    // The surplus goes back newest gift first: the second donor's share returns whole, and the rest comes off the first donor's.
    const kept = await db.rows<{ username: string; kept: number }>(
      "select u.username, sum(a.amount)::int as kept from allocations a join donations d on d.id = a.donation_id join users u on u.id = d.user_id where a.cat_id = $1 group by u.username order by u.username",
      [catId],
    );
    expect(kept.map((k) => [k.username, Number(k.kept)])).toEqual([
      ["e2e_donor", DONATION_1.gross - DONATION_1.fee - (SURPLUS - (PACKAGE - (DONATION_1.gross - DONATION_1.fee)))],
      ["e2e_donor2", 0],
    ]);
    expect(kept.reduce((s, k) => s + Number(k.kept), 0)).toBe(PACKAGE - SURPLUS);

    await signInAs(page, "e2e_donor");
    await page.goto("/helped");
    await expect(page.getByRole("link", { name: /Mocha/ }).first()).toBeVisible();
    await signInAs(page, "e2e_donor2");
    await page.goto("/helped");
    await expect(page.getByText("Your gift is in the shared fund.")).toBeVisible();
    await expect(page.getByRole("link", { name: /Mocha/ })).toHaveCount(0);
    await signInAs(page, "e2e_finder");
    await page.goto("/helped");
    await expect(page.getByRole("link", { name: /Mocha/ }).first()).toBeVisible();
    await page.goto(`/cats/${catId}`);
    await expect(page.getByText("Neutered").first()).toBeVisible();
    await page.goto("/cats");
    await expect(page.getByRole("link", { name: /Mocha/ }).first()).toBeVisible();
  });

  // ---------------------------------------------------------------- refund
  await test.step("PayPal refunds part of the second gift: its own negative row, the pool and the Proof line follow, a replay changes nothing", async () => {
    const REFUND = 2_000;
    const gift = await db.one<{ paypal_capture_id: string; status: string }>("select paypal_capture_id, status from donations where gross = $1", [DONATION_2.gross]);
    const money = (c: number) => ({ currency_code: "PHP", value: (c / 100).toFixed(2) });
    const event = {
      id: "E2E-EVENT-REFUND",
      event_type: "PAYMENT.CAPTURE.REFUNDED",
      resource: {
        id: "E2E-REFUND-1",
        status: "COMPLETED",
        amount: money(REFUND),
        seller_payable_breakdown: { gross_amount: money(REFUND), paypal_fee: money(0), net_amount: money(REFUND) },
        links: [{ rel: "up", href: `https://e2e.invalid/v2/payments/captures/${gift.paypal_capture_id}` }],
      },
    };
    const first = await page.request.post("/api/webhooks/paypal", { headers: PAYPAL_HEADERS, data: event });
    expect(await first.json()).toEqual({ result: "processed" });
    const replay = await page.request.post("/api/webhooks/paypal", { headers: PAYPAL_HEADERS, data: event });
    expect(await replay.json()).toEqual({ result: "duplicate" });
    const again = await page.request.post("/api/webhooks/paypal", { headers: PAYPAL_HEADERS, data: { ...event, id: "E2E-EVENT-REFUND-2" } });
    expect(again.ok()).toBe(true);

    // The gift itself is untouched; the refund is one row of its own.
    expect(await db.one("select status, gross, net from donations where gross = $1", [DONATION_2.gross])).toMatchObject({ status: "captured", gross: DONATION_2.gross });
    expect(await db.rows("select 1 from donation_reversals")).toHaveLength(1);

    const grossIn = DONATION_1.gross + DONATION_2.gross - REFUND;
    const fees = DONATION_1.fee + DONATION_2.fee;
    const left = grossIn - fees - (PACKAGE - SURPLUS) - (DEPOSIT_FEE + BALANCE_FEE);
    const snapshot = await (await page.request.get("/api/ledger")).json();
    expect(snapshot.pool).toMatchObject({ grossIn, paypalFees: fees, available: left, reversedGross: REFUND });
    expect(snapshot.rows.filter((r: { type: string }) => r.type === "refund")).toEqual([
      expect.objectContaining({ amount: -REFUND, fee: 0, status: "refunded", paypalId: "E2E-REFUND-1" }),
    ]);
    await page.goto("/impact");
    await expect(page.getByText("This adds up exactly, across every donation and payout.")).toBeVisible();
    await expect(page.getByText(`Donated ${peso(grossIn)} = PayPal fees ${peso(fees)}`, { exact: false })).toBeVisible();
    await expect(page.getByText(`${peso(REFUND)} that PayPal took back`, { exact: false })).toBeVisible();
  });

  // ---------------------------------------------------------------- privacy
  await test.step("no public page or answer holds the exact place, a private key or an email", async () => {
    const sighting = await db.one<{ exact_lat: number; exact_lng: number }>("select exact_lat, exact_lng from sightings where cat_id = $1", [catId]);
    const cat = await db.one<{ fuzzed_lat: number; fuzzed_lng: number }>("select fuzzed_lat, fuzzed_lng from cats where id = $1", [catId]);
    expect([cat.fuzzed_lat, cat.fuzzed_lng]).not.toEqual([Number(EXACT.lat), Number(EXACT.lng)]);

    const anonymous = await page.context().browser()!.newContext({ baseURL: page.url().split("/").slice(0, 3).join("/") });
    try {
      const paths = ["/", "/cats", `/cats/${catId}`, "/ledger", "/impact", "/agent", "/helped", "/missions", "/api/ledger", "/api/impact", "/api/agent/feed", `/api/cats/${catId}`];
      for (const p of paths) {
        const res = await anonymous.request.get(p);
        expect(res.status(), p).toBeLessThan(400);
        const body = await res.text();
        // The exact place rounded to 3 or more decimals must not appear either, in any number format.
        for (const secret of [...coordinateForms(sighting.exact_lat), ...coordinateForms(sighting.exact_lng)]) {
          expect(body, `${p} must not contain the coordinate ${secret}`).not.toContain(secret);
        }
        for (const secret of [EXACT.lat, EXACT.lng, "exact_lat", "exactLat", "exact_lng", "originals/", "demo-vet@e2e.invalid", "paypal_email", "paypalEmail"]) {
          expect(body, `${p} must not contain ${secret}`).not.toContain(secret);
        }
      }
    } finally {
      await anonymous.close();
    }
  });
});
