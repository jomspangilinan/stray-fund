/**
 * Real-request privacy check. Run against a dev or production server whose
 * DATABASE_URL points at DB_URL (a throwaway database). It inserts sentinel
 * data, fetches every public route as HTML and as an RSC payload (anonymous and
 * as a signed-in donor), and fails if any sentinel appears. It removes its rows
 * afterwards.
 *
 *   SESSION_SECRET=... DB_URL=postgres://... BASE_URL=http://localhost:3111 npx tsx scripts/check-public-leaks.ts
 */
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { Pool } from "pg";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const pool = new Pool({ connectionString: process.env.DB_URL });
const secret = new TextEncoder().encode(process.env.SESSION_SECRET ?? "");

const SENTINELS = [
  "10.987654321", "120.123456789", "10.55555555", "120.66666666", "11.246813579", "121.135792468",
  "leakcheck.sentinel@example.test", "originals/", "exact_lat", "exactLat", "fuzzed", "originalKey",
  "original_key", "locationApproximate", "paypal_email", "paypalEmail", "requested_sex", "assessment",
  "agentinputs-sentinel", "gatewayerror-sentinel", "caretakernote-sentinel", "resolution-sentinel", "reviewnote-sentinel",
  "Leakcheck Sentinel Clinic", "clinic_name", "clinicName", "OR-LEAK-SENTINEL", "receipt_number", "file_key", "fileKey",
  "ear_tip_photo_key", "earTipPhotoKey", "ear_tip_result", "earTipResult", "same_cat_confidence",
  "leakreceipt-sentinel-sha", "LeakItem-Sentinel", "tamper_signs",
];

async function main() {
  const tag = randomUUID().slice(0, 8);
  const { rows: [donor] } = await pool.query(
    "insert into users (username, role, paypal_email) values ($1,'donor',$2) returning id",
    [`leak_${tag}`, "leakcheck.sentinel@example.test"],
  );
  const { rows: [vet] } = await pool.query(
    "insert into users (username, role, paypal_email, clinic_name) values ($1,'vet',$2,'Leakcheck Sentinel Clinic') returning id",
    [`leakvet_${tag}`, "leakcheck.sentinel@example.test"],
  );
  const { rows: [cat] } = await pool.query(
    `insert into cats (name, sex, status, area_name, exact_lat, exact_lng, fuzzed_lat, fuzzed_lng, location_approximate, flags)
     values ($1,'female','neutered','Brgy. San Antonio, near the market',10.987654321,120.123456789,10.55555555,120.66666666,true,'{pregnant}') returning id`,
    [`LeakCat ${tag}`],
  );
  await pool.query(
    `insert into sightings (cat_id, original_key, public_key, public_ready, taken_at, exact_lat, exact_lng, requested_sex, assessment, state)
     values ($1,'originals/00000000-0000-4000-8000-000000000001.jpg','photos/00000000-0000-4000-8000-000000000002.jpg',true,now(),11.246813579,121.135792468,'female','{"x":1}','new_cat')`,
    [cat.id],
  );
  const { rows: [don] } = await pool.query(
    "insert into donations (user_id, gross, paypal_fee, net, paypal_order_id, status) values ($1,10000,0,10000,$2,'captured') returning id",
    [donor.id, `leak-${tag}`],
  );
  await pool.query("insert into allocations (donation_id, cat_id, purpose, amount) values ($1,$2,'vet',4000)", [don.id, cat.id]);

  const { rows: [booking] } = await pool.query(
    "insert into bookings (cat_id, vet_id, package_price, status, scheduled_for) values ($1,$2,150000,'completed',now()) returning id",
    [cat.id, vet.id],
  );
  const { rows: [receipt] } = await pool.query(
    `insert into receipts (booking_id, file_key, sha256, parsed, ear_tip_photo_key, ear_tip_result, verification, reasons)
     values ($1,'originals/00000000-0000-4000-8000-000000000003.jpg','leakreceipt-sentinel-sha',$2,'originals/00000000-0000-4000-8000-000000000004.jpg',$3,'verified','{}') returning id`,
    [
      booking.id,
      JSON.stringify({ clinic: "Leakcheck Sentinel Clinic", receipt_number: "OR-LEAK-SENTINEL", items: ["LeakItem-Sentinel"], tamper_signs: [] }),
      JSON.stringify({ ear_tip: "present", confidence: 0.9, same_cat_confidence: 0.9 }),
    ],
  );
  await pool.query(
    "insert into treatments (cat_id, type, product, date, vet_id, receipt_id) values ($1,'neuter','Leak check spay',current_date,$2,$3)",
    [cat.id, vet.id, receipt.id],
  );

  const token = await new SignJWT({ role: "donor", username: `leak_${tag}` })
    .setProtectedHeader({ alg: "HS256" }).setSubject(donor.id).setIssuedAt().setExpirationTime("1h").sign(secret);

  await pool.query(
    `insert into agent_actions (action, inputs, reason, amount, status, approved_by, paypal_ref)
     values ('fund_cat', $1, 'Leak check reason', 150000, 'done', $2, 'LEAKREF')`,
    [JSON.stringify({ catId: cat.id, secret: "agentinputs-sentinel", gatewayError: "gatewayerror-sentinel" }), donor.id],
  );
  // Caretaker actions keep what a person typed in inputs, and a resolved question keeps its note on the request.
  await pool.query(
    `insert into agent_actions (action, inputs, reason, status, approved_by)
     values ('evidence_accepted', $1, 'Caretaker reason', 'done', $2),
            ('payout_note', $3, 'Caretaker reason', 'done', $2),
            ('caretaker_review', $4, 'Caretaker reason', 'resolved', $2)`,
    [
      JSON.stringify({ catId: cat.id, note: "caretakernote-sentinel" }),
      donor.id,
      JSON.stringify({ catId: cat.id, note: "caretakernote-sentinel" }),
      JSON.stringify({ catId: cat.id, note: "reviewnote-sentinel" }),
    ],
  );
  // A payout whose action holds inputs and whose row holds a gateway error, both of which the ledger must not show.
  const { rows: [payAction] } = await pool.query(
    `insert into agent_actions (action, inputs, reason, amount, status, approved_by, paypal_ref)
     values ('payout_deposit', $1, 'Leak check payout reason', 7000, 'failed', $2, 'LEAKBATCH') returning id`,
    [JSON.stringify({ catId: cat.id, secret: "agentinputs-sentinel", gatewayError: "gatewayerror-sentinel" }), donor.id],
  );
  await pool.query(
    `insert into payouts (cat_id, booking_id, payee_user_id, amount, kind, action_id, status, last_gateway_error, paypal_payout_batch_id)
     values ($1,$2,$3,7000,'deposit',$4,'failed','gatewayerror-sentinel','LEAKBATCH')`,
    [cat.id, booking.id, vet.id, payAction.id],
  );
  await pool.query(
    "insert into review_requests (subject, reason, status, resolved_by, resolved_at, resolution) values ($1,'r','resolved',$2,now(),'resolution-sentinel')",
    [`leakreview-${tag}`, donor.id],
  );

  const paths = ["/", "/cats", "/cats?status=neutered", `/cats/${cat.id}`, "/helped", `/api/cats/${cat.id}`, "/api/cats/not-a-uuid", "/agent", "/api/agent/feed", "/ledger", "/ledger?q=LEAKBATCH", "/impact", "/missions", "/api/ledger", "/api/impact", "/vet", `/vet/bookings/${booking.id}`, "/caretaker", `/api/caretaker/images/receipt/${receipt.id}`, `/api/caretaker/images/eartip/${receipt.id}`];
  const viewers: [string, Record<string, string>][] = [["anon", {}], ["donor", { cookie: `sf_session=${token}` }]];
  let bad = 0, checked = 0;
  try {
    // The note shows until the browser confirms it, then never again. A confirmation for a cat the donor did not help is refused.
    const helpedPage = () => fetch(`${BASE}/helped`, { headers: { cookie: `sf_session=${token}` } }).then((r) => r.text());
    const firstHelped = await helpedPage();
    checked++;
    const leaked = SENTINELS.filter((x) => firstHelped.includes(x));
    if (leaked.length) { bad++; console.log(`LEAK donor first /helped: ${leaked.join(", ")}`); }
    if (!firstHelped.includes("came home from the vet. You helped fund this.")) { bad++; console.log("FAIL: the milestone note did not show"); }
    const seen = (catId: string) => fetch(`${BASE}/api/helped/seen`, { method: "POST", headers: { cookie: `sf_session=${token}`, "content-type": "application/json" }, body: JSON.stringify({ catId, milestone: "neutered" }) }).then((r) => r.json());
    if ((await seen(randomUUID())).marked) { bad++; console.log("FAIL: marked a milestone for a cat the donor did not help"); }
    if (!(await seen(cat.id)).marked) { bad++; console.log("FAIL: the confirmation was not accepted"); }
    if ((await helpedPage()).includes("You helped fund this.")) { bad++; console.log("FAIL: the milestone note showed again"); }
    for (const [who, base] of viewers) {
      for (const p of paths) {
        for (const rsc of [false, true]) {
          const res = await fetch(BASE + p, { headers: { ...base, ...(rsc ? { RSC: "1" } : {}) } });
          const text = await res.text();
          checked++;
          const hits = SENTINELS.filter((s) => text.includes(s));
          const note = `${who} ${rsc ? "rsc" : "html"} ${p} -> ${res.status} (${text.length} bytes)`;
          if (hits.length) { bad++; console.log(`LEAK ${note}: ${hits.join(", ")}`); } else console.log(`ok   ${note}`);
        }
      }
    }
    const html = await (await fetch(`${BASE}/cats/${cat.id}`)).text();
    if (!html.includes(`LeakCat ${tag}`)) { bad++; console.log("FAIL: seeded cat did not render, so the scan proved nothing"); }
    if (!html.includes("Leak check spay")) { bad++; console.log("FAIL: the seeded treatment did not render"); }
    const feed = await (await fetch(`${BASE}/agent`)).text();
    if (!feed.includes("Leak check reason")) { bad++; console.log("FAIL: agent feed did not render the seeded action"); }
    const ledger = await (await fetch(`${BASE}/api/ledger`)).text();
    for (const need of ["Leak check payout reason", "LEAKBATCH", `leak_${tag}`]) {
      if (!ledger.includes(need)) { bad++; console.log(`FAIL: the ledger API did not carry ${need}`); }
    }
    const ledgerRes = await fetch(`${BASE}/api/ledger`);
    if (ledgerRes.headers.get("cache-control") !== "no-store") { bad++; console.log("FAIL: /api/ledger is not no-store"); }
    if (!ledger.includes('"status":"failed"')) { bad++; console.log("FAIL: the failed payout is not marked failed"); }
    const helped = await (await fetch(`${BASE}/helped`, { headers: { cookie: `sf_session=${token}` } })).text();
    if (!helped.includes(`LeakCat ${tag}`)) { bad++; console.log("FAIL: helped page did not render the seeded cat"); }
  } finally {
    await pool.query("delete from review_requests where resolved_by=$1", [donor.id]);
    await pool.query("delete from payouts where booking_id=$1", [booking.id]);
    await pool.query("delete from agent_actions where approved_by=$1", [donor.id]);
    await pool.query("delete from milestone_seen where user_id=$1", [donor.id]);
    await pool.query("delete from allocations where donation_id=$1", [don.id]);
    await pool.query("delete from donations where id=$1", [don.id]);
    await pool.query("delete from treatments where cat_id=$1", [cat.id]);
    await pool.query("delete from receipts where booking_id=$1", [booking.id]);
    await pool.query("delete from bookings where id=$1", [booking.id]);
    await pool.query("delete from sightings where cat_id=$1", [cat.id]);
    await pool.query("delete from cats where id=$1", [cat.id]);
    await pool.query("delete from users where id=$1", [vet.id]);
    await pool.query("delete from users where id=$1", [donor.id]);
    await pool.end();
  }
  console.log(bad ? `FAILED: ${bad} problems in ${checked} fetches` : `PASSED: ${checked} fetches clean`);
  process.exit(bad ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
