import { sql } from "drizzle-orm";
import { db, type Tx } from "./db/client";
import { CAPTURED, getPoolStatus, toInt, type PoolStatus } from "./ledger";
import { publicLedgerRow, STATUS_GROUPS, type PublicLedgerRow } from "./public";

/*
 * The impact page and the public ledger. Both are aggregates or whitelisted rows: the ledger query selects
 * named columns and goes through publicLedgerRow, so no email, input, note or gateway error can ride along.
 */

export type Impact = {
  /** Cats the fund neutered: a neuter treatment is on record. */
  catsNeutered: number;
  catsVaccinated: number;
  catsDewormed: number;
  catsAdopted: number;
  catsWaiting: number;
  /** Ear-tipped when found, with no neuter treatment from the fund. Never credited to it. */
  alreadyNeutered: number;
  meals: number;
  pool: PoolStatus;
};

const waiting = sql.join(
  STATUS_GROUPS.waiting.map((s) => sql`${s}`),
  sql`, `,
);

export async function getImpact(): Promise<Impact> {
  return db.transaction(
    async (tx) => {
      const pool = await getPoolStatus(tx);
      const { rows } = await tx.execute(sql`
        select
          (select count(distinct cat_id) from treatments where type = 'neuter') as neutered,
          (select count(distinct cat_id) from treatments where type = 'vaccine') as vaccinated,
          (select count(distinct cat_id) from treatments where type = 'deworming') as dewormed,
          (select count(*) from cats where status = 'adopted') as adopted,
          (select count(*) from cats where status in (${waiting})) as waiting,
          (select count(*) from cats c where c.ear_tipped = true
             and not exists (select 1 from treatments t where t.cat_id = c.id and t.type = 'neuter')) as already,
          (select count(*) from meals) as meals
      `);
      const r = rows[0] as Record<string, unknown>;
      return {
        catsNeutered: toInt(r.neutered),
        catsVaccinated: toInt(r.vaccinated),
        catsDewormed: toInt(r.dewormed),
        catsAdopted: toInt(r.adopted),
        catsWaiting: toInt(r.waiting),
        alreadyNeutered: toInt(r.already),
        meals: toInt(r.meals),
        pool,
      };
    },
    { isolationLevel: "repeatable read" },
  );
}

const PAYOUT_TYPE = { deposit: "vet_deposit", balance: "vet_balance" } as const;

/**
 * One row per captured donation and per payout, newest first. Pending donations are left out because no
 * money moved. Failed and refused payouts stay, marked by their status. The reason is the treasurer's own
 * public sentence; inputs, approvers and gateway errors are never selected.
 */
async function ledgerRows(tx: Tx): Promise<PublicLedgerRow[]> {
  const { rows } = await tx.execute(sql`
    select * from (
      select d.created_at, to_char(d.created_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as day, 'donation' as type, d.gross as amount, d.paypal_fee as fee,
             null::text as cat, null::uuid as cat_id, null::text as reason,
             coalesce(d.paypal_capture_id, d.paypal_order_id) as paypal_id,
             d.status, coalesce(u.username, 'Anonymous') as who
      from donations d left join users u on u.id = d.user_id
      where d.status = ${CAPTURED}
      union all
      select p.created_at, to_char(p.created_at at time zone 'Asia/Manila', 'YYYY-MM-DD'), case p.kind when 'deposit' then ${PAYOUT_TYPE.deposit} else ${PAYOUT_TYPE.balance} end,
             p.amount, p.fee, c.name, p.cat_id, a.reason,
             coalesce(p.paypal_payout_batch_id, p.paypal_item_id), p.status, v.username
      from payouts p
      join cats c on c.id = p.cat_id
      join agent_actions a on a.id = p.action_id
      join users v on v.id = p.payee_user_id
    ) l
    order by l.created_at desc, l.paypal_id desc nulls last
  `);
  return (rows as Record<string, unknown>[]).map((r) =>
    publicLedgerRow({
      date: String(r.day),
      type: String(r.type),
      amount: toInt(r.amount),
      fee: r.fee === null ? null : toInt(r.fee),
      cat: (r.cat as string | null) ?? null,
      catId: (r.cat_id as string | null) ?? null,
      reason: (r.reason as string | null) ?? null,
      paypalId: (r.paypal_id as string | null) ?? null,
      status: String(r.status),
      who: (r.who as string | null) ?? null,
    }),
  );
}

export type LedgerSnapshot = { rows: PublicLedgerRow[]; pool: PoolStatus };

/** Rows and pool figures read in one snapshot, so the totals of the rows always equal the pool. */
export async function getLedgerSnapshot(): Promise<LedgerSnapshot> {
  return db.transaction(
    async (tx) => {
      const pool = await getPoolStatus(tx);
      return { rows: await ledgerRows(tx), pool };
    },
    { isolationLevel: "repeatable read" },
  );
}

export async function getLedger(): Promise<PublicLedgerRow[]> {
  return (await getLedgerSnapshot()).rows;
}
