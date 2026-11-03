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
  "agentinputs-sentinel", "gatewayerror-sentinel",
];

async function main() {
  const tag = randomUUID().slice(0, 8);
  const { rows: [donor] } = await pool.query(
    "insert into users (username, role, paypal_email) values ($1,'donor',$2) returning id",
    [`leak_${tag}`, "leakcheck.sentinel@example.test"],
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

  const token = await new SignJWT({ role: "donor", username: `leak_${tag}` })
    .setProtectedHeader({ alg: "HS256" }).setSubject(donor.id).setIssuedAt().setExpirationTime("1h").sign(secret);

  await pool.query(
    `insert into agent_actions (action, inputs, reason, amount, status, approved_by, paypal_ref)
     values ('fund_cat', $1, 'Leak check reason', 150000, 'done', $2, 'LEAKREF')`,
    [JSON.stringify({ catId: cat.id, secret: "agentinputs-sentinel", gatewayError: "gatewayerror-sentinel" }), donor.id],
  );

  const paths = ["/", "/cats", "/cats?status=neutered", `/cats/${cat.id}`, "/collection", `/api/cats/${cat.id}`, "/api/cats/not-a-uuid", "/agent", "/api/agent/feed"];
  const viewers: [string, Record<string, string>][] = [["anon", {}], ["donor", { cookie: `sf_session=${token}` }]];
  let bad = 0, checked = 0;
  try {
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
    const col = await (await fetch(`${BASE}/collection`, { headers: { cookie: `sf_session=${token}` } })).text();
    if (!col.includes(`LeakCat ${tag}`)) { bad++; console.log("FAIL: collection did not render the seeded cat"); }
  } finally {
    await pool.query("delete from allocations where donation_id=$1", [don.id]);
    await pool.query("delete from donations where id=$1", [don.id]);
    await pool.query("delete from sightings where cat_id=$1", [cat.id]);
    await pool.query("delete from cats where id=$1", [cat.id]);
    await pool.query("delete from users where id=$1", [donor.id]);
    await pool.end();
  }
  console.log(bad ? `FAILED: ${bad} problems in ${checked} fetches` : `PASSED: ${checked} fetches clean`);
  process.exit(bad ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
