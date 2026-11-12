/**
 * Real-request privacy check. Run against a dev or production server whose
 * DATABASE_URL points at DB_URL (a throwaway database). It inserts sentinel
 * data, fetches every public route as HTML and as an RSC payload (anonymous and
 * as a signed-in donor), and fails if any sentinel appears. It removes its rows
 * afterwards.
 *
 *   SESSION_SECRET=... DB_URL=postgres://... BASE_URL=http://localhost:3111 npx tsx scripts/check-public-leaks.ts
 *
 * It fetches as a signed-out visitor and as each demo role (neighbour, caretaker, vet). For the report story it adds a
 * note holding a phone number, a street and a person's name, and Treasurer reasons that repeat that note. Run the
 * server with DEMO_MODE=true. The caretaker desk there shows a report's note as written (the owner's call) and hides
 * only the AI's reasons; no public page or payload may carry the note.
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
  // Ear-tip answers are private: no table name, no column name, and nobody's answer beyond their own.
  "ear_tip_flags", "earTipFlags", "requested_ear_tip", "requestedEarTip", "earTipYes", "earTipNo", "answeredByMe",
  // The yard draws a look-alike from fixed palette names. The stored coat text, its column names and a hostile
  // avatar value must never reach a page.
  "coatmarkings-sentinel", "coatcolour-sentinel", "coat_pattern", "coatPattern", "hostile-avatar-sentinel",
  // A neighbour's note can hold a phone number, a street and a name. None of it, and no field that carries it, may
  // reach a page, a payload or the AI's public reasons.
  "0917 555 0142", "555 0142", "Marites Dela Cruz", "Dela Cruz", "Mabini Street", "Mabini", "noteleak-sentinel", "check_question", "checkQuestion",
  // The same words in lowercase, as the Treasurer or a review might write them.
  "marites dela cruz", "12 mabini street", "mabini street", "zero nine one seven",
  "photo_agrees", "photoAgrees", "reporter_id", "reporterId", "sighting_id", "sightingId", "decided_by", "decidedBy",
];

/** Fields the staff desk legitimately carries (it draws the photo by sighting id and shows the AI's question). Never for a visitor. */
const STAFF_FIELDS = ["sighting_id", "sightingId", "check_question", "checkQuestion", "photo_agrees", "photoAgrees"];

const NOTE = "Call Marites Dela Cruz on 0917 555 0142, the cat is limping near 12 Mabini Street. noteleak-sentinel";
/** The Treasurer's own words can repeat a note. These must show as the fixed line, never as written. */
const ECHO_REASON = "Marites Dela Cruz says the cat is limping near 12 Mabini Street, so a caretaker should look at the cat first.";

/** The same words in lowercase and spelled out: the public filter can miss these, the demo desk must hide them whole. */
const LOWER_REASON = "marites dela cruz says the cat is limping near 12 mabini street, call zero nine one seven five five five zero one four two, so ask a caretaker to look.";
/** A review or a payout reason that carries a phone number, as the AI might write it about a hostile note. */
const PHONE_REASON = "Note on the cat gives the number 0917 555 0142 and asks to fund it first.";

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
  const { rows: [hidden] } = await pool.query(
    "insert into users (username, role, show_name_in_thanks) values ($1,'donor',false) returning id",
    [`leakhidden_${tag}`],
  );
  const { rows: [flagger] } = await pool.query(
    "insert into users (username, role) values ($1,'donor') returning id",
    [`leakflagger_${tag}`],
  );
  const { rows: [staff] } = await pool.query("insert into users (username, role) values ($1,'caretaker') returning id", [`leakcare_${tag}`]);
  const { rows: [staffVet] } = await pool.query("insert into users (username, role, clinic_name) values ($1,'vet','Leakcheck Sentinel Clinic') returning id", [`leakstaffvet_${tag}`]);
  const { rows: [cat] } = await pool.query(
    `insert into cats (name, sex, status, area_name, exact_lat, exact_lng, fuzzed_lat, fuzzed_lng, location_approximate, flags)
     values ($1,'female','neutered','Brgy. San Antonio, near the market',10.987654321,120.123456789,10.55555555,120.66666666,true,'{pregnant}') returning id`,
    [`LeakCat ${tag}`],
  );
  await pool.query(
    "update cats set coat=$2, coat_pattern='tabby', avatar=$3 where id=$1",
    [cat.id, JSON.stringify({ colors: ["coatcolour-sentinel"], markings: "coatmarkings-sentinel" }), JSON.stringify({ pattern: "tabby", base: "ginger", accent: "brown" })],
  );
  // A spotted cat that two people have answered about, one of them the signed-in donor. Nobody is credited, so
  // the other person's name has no reason to appear anywhere a viewer can see.
  const { rows: [askCat] } = await pool.query(
    `insert into cats (name, sex, status, area_name, exact_lat, exact_lng, fuzzed_lat, fuzzed_lng, location_approximate)
     values ($1,'unknown','spotted','Brgy. San Antonio, near the market',10.987654321,120.123456789,10.55555555,120.66666666,true) returning id`,
    [`LeakAsk ${tag}`],
  );
  await pool.query("insert into ear_tip_flags (cat_id, user_id, value) values ($1,$2,'no'), ($1,$3,'yes')", [askCat.id, flagger.id, donor.id]);
  // A tampered avatar: it must fall back to the neutral cat, and none of its text may reach the page.
  await pool.query("update cats set avatar=$2 where id=$1", [askCat.id, JSON.stringify({ pattern: "tabby", base: "hostile-avatar-sentinel", accent: "brown" })]);
  await pool.query(
    "insert into sightings (cat_id, original_key, caught_by_user_id, state) values ($1,'originals/00000000-0000-4000-8000-000000000009.jpg',$2,'matched')",
    [cat.id, hidden.id],
  );
  await pool.query(
    `insert into sightings (cat_id, original_key, public_key, public_ready, taken_at, exact_lat, exact_lng, requested_sex, assessment, state)
     values ($1,'originals/00000000-0000-4000-8000-000000000001.jpg','photos/00000000-0000-4000-8000-000000000002.jpg',true,now(),11.246813579,121.135792468,'female','{"x":1}','new_cat')`,
    [cat.id],
  );
  // The report story. A spotted cat with an open note (needs a person first), a queued cat the Treasurer moved citing a
  // vet-cleared report (next to fund), and the neutered cat's own timeline with a dismissed and a confirmed report.
  const place = "'Brgy. San Antonio, near the market',10.987654321,120.123456789,10.55555555,120.66666666,true";
  const { rows: [openCat] } = await pool.query(
    `insert into cats (name, sex, status, area_name, exact_lat, exact_lng, fuzzed_lat, fuzzed_lng, location_approximate, queued_at)
     values ($1,'male','queued',${place}, now() - interval '3 days') returning id`,
    [`LeakOpen ${tag}`],
  );
  const { rows: [movedCat] } = await pool.query(
    `insert into cats (name, sex, status, area_name, exact_lat, exact_lng, fuzzed_lat, fuzzed_lng, location_approximate, queued_at, flags)
     values ($1,'male','queued',${place}, now() - interval '5 days', '{injured}') returning id`,
    [`LeakMoved ${tag}`],
  );
  const { rows: [firstCat] } = await pool.query(
    `insert into cats (name, sex, status, area_name, exact_lat, exact_lng, fuzzed_lat, fuzzed_lng, location_approximate, queued_at)
     values ($1,'female','queued',${place}, now() - interval '9 days') returning id`,
    [`LeakFirst ${tag}`],
  );
  const { rows: [openSighting] } = await pool.query(
    "insert into sightings (cat_id, original_key, caught_by_user_id, state, exact_lat, exact_lng) values ($1,'originals/00000000-0000-4000-8000-00000000000a.jpg',$2,'matched',11.246813579,121.135792468) returning id",
    [openCat.id, donor.id],
  );
  await pool.query(
    "insert into reports (cat_id, sighting_id, claim, note, source, reporter_id, reported_on, check_question) values ($1,$2,'injured',$3,'neighbour',$4,current_date,$5)",
    [openCat.id, openSighting.id, NOTE, donor.id, `Can you look at the cat near 12 Mabini Street? noteleak-sentinel`],
  );
  const { rows: [clearedReport] } = await pool.query(
    "insert into reports (cat_id, claim, note, source, reporter_id, status, decided_by, decided_at, reported_on) values ($1,'injured',$2,'neighbour',$3,'cleared',$4,now(),current_date) returning id",
    [movedCat.id, NOTE, flagger.id, staffVet.id],
  );
  await pool.query(
    "insert into cat_priority (cat_id, before_cat_id, report_id, passed_cat_ids, reason) values ($1,$2,$3,$4,$5)",
    [movedCat.id, firstCat.id, clearedReport.id, [firstCat.id], ECHO_REASON],
  );
  await pool.query(
    `insert into agent_actions (action, inputs, reason, status) values
       ('set_cat_place', $1, $3, 'done'),
       ('ask_for_check', $2, $3, 'done')`,
    [JSON.stringify({ catId: movedCat.id, reportId: clearedReport.id }), JSON.stringify({ catId: openCat.id }), ECHO_REASON],
  );
  // The neutered cat's timeline: a dismissed and a confirmed report, and the Treasurer repeating the note.
  await pool.query(
    `insert into reports (cat_id, claim, note, source, reporter_id, status, decided_by, decided_at, reported_on) values
       ($1,'sick',$2,'neighbour',$3,'dismissed',$4,now() - interval '2 days',current_date - 3),
       ($1,'injured',$2,'neighbour',$5,'confirmed',$4,now() - interval '1 days',current_date - 2)`,
    [cat.id, NOTE, flagger.id, staff.id, hidden.id],
  );
  await pool.query(
    `insert into agent_actions (action, inputs, reason, status, created_at) values ('ask_for_check', $1, $2, 'done', now() - interval '1 days')`,
    [JSON.stringify({ catId: cat.id }), ECHO_REASON],
  );

  // A funded cat with a hurt report filed after funding, a deposit waiting for approval whose reason carries a phone
  // number, and an open review that does too, plus lowercase forms. The demo desk hides the AI's words whole.
  const { rows: [fundedCat] } = await pool.query(
    `insert into cats (name, sex, status, area_name, exact_lat, exact_lng, fuzzed_lat, fuzzed_lng, location_approximate, queued_at)
     values ($1,'female','funded',${place}, now() - interval '8 days') returning id`,
    [`LeakFunded ${tag}`],
  );
  await pool.query(
    "insert into reports (cat_id, claim, note, source, reporter_id, reported_on) values ($1,'injured',$2,'neighbour',$3,current_date)",
    [fundedCat.id, NOTE.toLowerCase(), flagger.id],
  );
  const { rows: [fundedBooking] } = await pool.query(
    "insert into bookings (cat_id, vet_id, package_price, status, scheduled_for) values ($1,$2,150000,'confirmed',now() + interval '2 days') returning id",
    [fundedCat.id, vet.id],
  );
  const { rows: [phoneAction] } = await pool.query(
    `insert into agent_actions (action, inputs, reason, amount, status, approved_by)
     values ('payout_deposit', $1, $2, 45000, 'awaiting_approval', $3) returning id`,
    [JSON.stringify({ catId: fundedCat.id }), PHONE_REASON, donor.id],
  );
  await pool.query(
    `insert into payouts (cat_id, booking_id, payee_user_id, amount, kind, action_id, status)
     values ($1,$2,$3,45000,'deposit',$4,'awaiting_approval')`,
    [fundedCat.id, fundedBooking.id, vet.id, phoneAction.id],
  );
  await pool.query(
    `insert into agent_actions (action, inputs, reason, status, approved_by) values
       ('set_cat_place', $1, $2, 'done', $3), ('ask_for_check', $1, $4, 'done', $3)`,
    [JSON.stringify({ catId: fundedCat.id }), LOWER_REASON, donor.id, PHONE_REASON],
  );
  await pool.query(
    "insert into review_requests (subject, reason, status) values ($1,$2,'open'), ($3,$4,'open')",
    [`leakopenreview-${tag}`, PHONE_REASON, LOWER_REASON, LOWER_REASON],
  );

  const { rows: [don] } = await pool.query(
    "insert into donations (user_id, gross, paypal_fee, net, paypal_order_id, status) values ($1,10000,0,10000,$2,'captured') returning id",
    [donor.id, `leak-${tag}`],
  );
  await pool.query("insert into allocations (donation_id, cat_id, purpose, amount) values ($1,$2,'vet',4000)", [don.id, cat.id]);

  // The opted-out donor also gave: the ledger rows must read "A neighbour", on every page and in the API.
  await pool.query(
    "insert into donations (user_id, gross, paypal_fee, net, paypal_order_id, paypal_capture_id, status) values ($1,5000,0,5000,$2,$3,'captured')",
    [hidden.id, `leakhid-order-${tag}`, `leakhid-cap-${tag}`],
  );
  SENTINELS.push(`leakhidden_${tag}`);

  const { rows: [booking] } = await pool.query(
    "insert into bookings (cat_id, vet_id, package_price, status, scheduled_for) values ($1,$2,150000,'completed',now()) returning id",
    [cat.id, vet.id],
  );
  const { rows: [receipt] } = await pool.query(
    `insert into receipts (booking_id, file_key, sha256, parsed, ear_tip_photo_key, verification, reasons)
     values ($1,'originals/00000000-0000-4000-8000-000000000003.jpg','leakreceipt-sentinel-sha',$2,'originals/00000000-0000-4000-8000-000000000004.jpg','verified','{}') returning id`,
    [
      booking.id,
      JSON.stringify({ clinic: "Leakcheck Sentinel Clinic", receipt_number: "OR-LEAK-SENTINEL", items: ["LeakItem-Sentinel"], tamper_signs: [] }),
    ],
  );
  await pool.query(
    "insert into treatments (cat_id, type, product, date, vet_id, receipt_id) values ($1,'neuter','Leak check spay',current_date,$2,$3)",
    [cat.id, vet.id, receipt.id],
  );

  const sign = (role: string, username: string, id: string) =>
    new SignJWT({ role, username }).setProtectedHeader({ alg: "HS256" }).setSubject(id).setIssuedAt().setExpirationTime("1h").sign(secret);
  const token = await sign("donor", `leak_${tag}`, donor.id);
  const careToken = await sign("caretaker", `leakcare_${tag}`, staff.id);
  const vetToken = await sign("vet", `leakstaffvet_${tag}`, staffVet.id);

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

  const paths = ["/", "/cats", "/cats?status=neutered", `/cats/${cat.id}`, "/helped", `/api/cats/${cat.id}`, `/cats/${askCat.id}`, `/api/cats/${askCat.id}`, "/api/cats/not-a-uuid", "/agent", "/api/agent/feed", "/ledger", "/ledger?q=LEAKBATCH", "/impact", "/missions", "/api/ledger", "/api/impact", "/priority", "/api/priority", `/cats/${openCat.id}`, `/api/cats/${openCat.id}`, `/cats/${movedCat.id}`, `/api/cats/${movedCat.id}`, `/cats/${fundedCat.id}`, `/api/cats/${fundedCat.id}`, "/vet", `/vet/bookings/${booking.id}`, "/caretaker", `/api/caretaker/images/receipt/${receipt.id}`, `/api/caretaker/images/eartip/${receipt.id}`];
  const viewers: [string, Record<string, string>][] = [
    ["anon", {}],
    ["neighbour", { cookie: `sf_session=${token}` }],
    ["caretaker", { cookie: `sf_session=${careToken}` }],
    ["vet", { cookie: `sf_session=${vetToken}` }],
  ];
  // Another person's name must not be found for any viewer, whatever they answered.
  SENTINELS.push(`leakflagger_${tag}`);
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
          const hits = SENTINELS.filter((s) => text.includes(s) && !((who === "caretaker" || who === "vet") && STAFF_FIELDS.includes(s)));
          const note = `${who} ${rsc ? "rsc" : "html"} ${p} -> ${res.status} (${text.length} bytes)`;
          if (hits.length) { bad++; console.log(`LEAK ${note}: ${hits.join(", ")}`); } else console.log(`ok   ${note}`);
        }
      }
    }
    const html = await (await fetch(`${BASE}/cats/${cat.id}`)).text();
    if (!html.includes(`LeakCat ${tag}`)) { bad++; console.log("FAIL: seeded cat did not render, so the scan proved nothing"); }
    if (!html.includes("Leak check spay")) { bad++; console.log("FAIL: the seeded treatment did not render"); }
    if (!html.includes("Thanks to") || !html.includes("helped fund") || !html.includes(`leak_${tag}`)) { bad++; console.log("FAIL: the cat card did not thank the donor"); }
    if (html.includes(`leakhidden_${tag}`) || !html.includes("A neighbour")) { bad++; console.log("FAIL: an opted-out name showed, or A neighbour did not"); }
    // The signed-in donor is asked about the spotted cat, anyone else is not, and nobody sees the other answers.
    const askAnon = await (await fetch(`${BASE}/cats/${askCat.id}`)).text();
    const askDonor = await (await fetch(`${BASE}/cats/${askCat.id}`, { headers: { cookie: `sf_session=${token}` } })).text();
    if (askAnon.includes("Does this cat have a tipped ear?")) { bad++; console.log("FAIL: a signed-out visitor was asked about the ear-tip"); }
    if (!askDonor.includes("Does this cat have a tipped ear?")) { bad++; console.log("FAIL: the signed-in donor was not asked about the ear-tip"); }
    // The client component's props travel in the page as JSON, with quotes that may be escaped.
    if (!/initial\\*"\s*:\s*\\*"yes/.test(askDonor)) { bad++; console.log(`FAIL: the donor's own answer did not come back to them: ${askDonor.slice(askDonor.indexOf("initial") - 20, askDonor.indexOf("initial") + 40)}`); }
    for (const [who, text] of [["anon", askAnon], ["donor", askDonor]]) {
      if (/No ear-tip seen/.test(text)) { bad++; console.log(`FAIL: ${who} saw the old ear-tip tag`); }
    }
    const homeHtml = await (await fetch(`${BASE}/`)).text();
    if (homeHtml.includes(`leakhidden_${tag}`)) { bad++; console.log("FAIL: an opted-out name showed on home"); }
    // The yard draws every cat as a link with a name and a status, and only fixed palette colours.
    for (const [who, text] of [["anon", homeHtml], ["donor", await (await fetch(`${BASE}/`, { headers: { cookie: `sf_session=${token}` } })).text()]] as const) {
      if (!text.includes(`href="/cats/${cat.id}"`) || !text.includes(`LeakCat ${tag}, Neutered`)) { bad++; console.log(`FAIL: ${who} home yard did not link the seeded cat with a name and status`); }
      if (!text.includes("#e8a15a")) { bad++; console.log(`FAIL: ${who} home yard did not draw the seeded cat's palette colour`); }
      if (!text.includes(`href="/cats/${askCat.id}"`)) { bad++; console.log(`FAIL: ${who} home yard dropped the cat with a tampered avatar instead of showing the neutral cat`); }
    }
    // The priority list and the timeline really rendered, so a clean scan means something, and the Treasurer's echo is the fixed line.
    const priority = await (await fetch(`${BASE}/priority`)).text();
    const priorityApi = await (await fetch(`${BASE}/api/priority`)).text();
    for (const need of [`LeakOpen ${tag}`, `LeakMoved ${tag}`, `LeakFirst ${tag}`, "Needs a person first", "Neighbour says hurt", "The Treasurer changed the order after a check."]) {
      if (!priority.includes(need)) { bad++; console.log(`FAIL: /priority did not carry "${need}"`); }
    }
    if (!priorityApi.includes(`LeakMoved ${tag}`)) { bad++; console.log("FAIL: /api/priority did not carry the moved cat"); }
    const timeline = await (await fetch(`${BASE}/cats/${cat.id}`)).text();
    for (const need of ["Neighbour reported hurt", "A caretaker checked this report and closed it.", "Treasurer asked a caretaker to check", "The Treasurer asked a caretaker to look at a cat."]) {
      if (!timeline.includes(need)) { bad++; console.log(`FAIL: the cat page timeline did not carry "${need}"`); }
    }
    // The demo caretaker desk shows a report's note as written and hides the AI's reasons whole.
    for (const [who, c] of [["caretaker", careToken], ["vet", vetToken]] as const) {
      const desk = await (await fetch(`${BASE}/caretaker`, { headers: { cookie: `sf_session=${c}` } })).text();
      checked++;
      if (who === "caretaker") {
        for (const need of [`LeakOpen ${tag}`, `LeakFunded ${tag}`, NOTE, "Hidden in the demo"]) {
          if (!desk.includes(need)) { bad++; console.log(`FAIL: the caretaker desk did not carry "${need}", so the scan proved nothing`); }
        }
        // The AI's words on a payout and a review are hidden whole, not filtered: a lowercase name or a spelled-out number gets past a filter.
        for (const gone of [PHONE_REASON, LOWER_REASON, `leakopenreview-${tag}`, "zero nine one seven"]) {
          if (desk.includes(gone)) { bad++; console.log(`LEAK caretaker desk carries "${gone.slice(0, 40)}"`); }
        }
      }
    }
    // A report on a funded cat shows on its public timeline as a fact, never as its note.
    const fundedPage = await (await fetch(`${BASE}/cats/${fundedCat.id}`)).text();
    if (!fundedPage.includes(`LeakFunded ${tag}`) || !fundedPage.includes("Neighbour reported hurt")) { bad++; console.log("FAIL: the funded cat page did not carry its name and the report on its timeline"); }
    for (const fixed of ["The Treasurer changed the order after a check.", "The Treasurer asked a caretaker to look at a cat."]) {
      if (!fundedPage.includes(fixed)) { bad++; console.log(`FAIL: the funded cat timeline did not show the fixed line "${fixed}" for an echoing reason`); }
    }
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
    await pool.query("delete from cat_priority where cat_id = any($1)", [[movedCat.id]]);
    await pool.query("delete from payouts where booking_id=$1", [fundedBooking.id]);
    await pool.query("delete from bookings where id=$1", [fundedBooking.id]);
    await pool.query("delete from review_requests where reason = any($1)", [[PHONE_REASON, LOWER_REASON]]);
    await pool.query("delete from reports where cat_id = any($1)", [[openCat.id, movedCat.id, cat.id, fundedCat.id]]);
    await pool.query("delete from agent_actions where inputs->>'catId' = any($1) or reason = $2", [[openCat.id, movedCat.id], ECHO_REASON]);
    await pool.query("delete from sightings where cat_id = $1", [openCat.id]);
    await pool.query("delete from agent_actions where inputs->>'catId' = $1", [fundedCat.id]);
    await pool.query("delete from cats where id = any($1)", [[openCat.id, movedCat.id, firstCat.id, fundedCat.id]]);
    await pool.query("delete from review_requests where resolved_by=$1", [donor.id]);
    await pool.query("delete from payouts where booking_id=$1", [booking.id]);
    await pool.query("delete from agent_actions where approved_by=$1", [donor.id]);
    await pool.query("delete from milestone_seen where user_id=$1", [donor.id]);
    await pool.query("delete from allocations where donation_id=$1", [don.id]);
    await pool.query("delete from donations where id=$1", [don.id]);
    await pool.query("delete from treatments where cat_id=$1", [cat.id]);
    await pool.query("delete from receipts where booking_id=$1", [booking.id]);
    await pool.query("delete from bookings where id=$1", [booking.id]);
    await pool.query("delete from ear_tip_flags where cat_id=$1", [askCat.id]);
    await pool.query("delete from cats where id=$1", [askCat.id]);
    await pool.query("delete from users where id=$1", [flagger.id]);
    await pool.query("delete from sightings where cat_id=$1", [cat.id]);
    await pool.query("delete from donations where user_id=$1", [hidden.id]);
    await pool.query("delete from users where id=$1", [hidden.id]);
    await pool.query("delete from cats where id=$1", [cat.id]);
    await pool.query("delete from users where id=$1", [vet.id]);
    await pool.query("delete from users where id=any($1)", [[staff.id, staffVet.id]]);
    await pool.query("delete from users where id=$1", [donor.id]);
    await pool.end();
  }
  console.log(bad ? `FAILED: ${bad} problems in ${checked} fetches` : `PASSED: ${checked} fetches clean`);
  process.exit(bad ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
