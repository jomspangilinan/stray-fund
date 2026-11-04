"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { PriorityList as PriorityData, PriorityRow } from "@/server/public";
import { CatPhoto } from "./CatPhoto";

const POLL_MS = 10_000;
const CLAIMS = new Set(["Hurt", "Pregnant", "Sick", "Kitten"]);

function tagClass(label: string): string {
  if (CLAIMS.has(label)) return "tag tag-bad";
  if (label === "Caretaker confirmed" || label === "Vet ready") return "tag";
  return "tag tag-says";
}

function Row({ row }: { row: PriorityRow }) {
  return (
    <li className="min-w-0">
      <Link href={`/cats/${row.catId}`} className="press row !items-start !py-3">
        <span className="relative mt-0.5 h-[52px] w-[52px] flex-none overflow-hidden rounded-in">
          <CatPhoto url={row.photoUrl} name={row.name} sizes="52px" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            {row.position !== null && (
              <span
                aria-label={`Place ${row.position}`}
                className={`grid h-6 w-6 flex-none place-items-center rounded-full text-[0.8125rem] font-extrabold tabular-nums ${row.position === 1 ? "bg-main text-white" : "bg-pale text-ink"}`}
              >
                {row.position}
              </span>
            )}
            <span className="min-w-0 truncate text-base font-bold leading-tight">{row.name}</span>
          </span>
          <span className="mt-1 block [overflow-wrap:anywhere] leading-snug">{row.reason}</span>
          {row.fundNote && <span className="small mt-1 block font-bold text-main">{row.fundNote}</span>}
          {row.labels.length > 0 && (
            <span className="mt-2 flex flex-wrap gap-1.5">
              {row.labels.map((l) => (
                <span key={l} className={tagClass(l)}>
                  {l}
                </span>
              ))}
            </span>
          )}
        </span>
      </Link>
    </li>
  );
}

function Group({ title, lead, rows }: { title: string; lead: string; rows: PriorityRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="mt-7 first:mt-5">
      <h2 className="h2">{title}</h2>
      <p className="small soft mt-0.5">{lead}</p>
      <ul className="list mt-3">
        {rows.map((r) => (
          <Row key={r.catId} row={r} />
        ))}
      </ul>
    </section>
  );
}

/** Takes only serialized public data, then refreshes it. A failed refresh keeps what is on screen, and says so. */
export function PriorityList({ initial }: { initial: PriorityData }) {
  const [data, setData] = useState(initial);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let live = true;
    const timer = setInterval(async () => {
      try {
        const res = await fetch("/api/priority", { cache: "no-store" });
        if (!res.ok) throw new Error("priority");
        const body = (await res.json()) as PriorityData;
        if (live) {
          setData(body);
          setStale(false);
        }
      } catch {
        if (live) setStale(true);
      }
    }, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  const empty = data.needsPerson.length === 0 && data.nextToFund.length === 0;
  return (
    <>
      {stale && (
        <p role="status" className="note note-bad mt-5 font-bold">
          Could not refresh the list. What you see may be out of date, and we will keep trying.
        </p>
      )}
      {empty ? (
        <div className="card mt-5">
          <p className="font-bold">No cats need funding or a check right now.</p>
          <p className="mt-1 soft">When someone spots a cat, it shows up here.</p>
          <Link href="/spot" className="btn mt-4">
            Spot a cat
          </Link>
        </div>
      ) : (
        <div aria-live="polite">
          <Group title="Needs a person first" lead="A caretaker or vet checks these before any money moves." rows={data.needsPerson} />
          <Group title="Next to fund" lead="In the order the Treasurer will fund them." rows={data.nextToFund} />
        </div>
      )}
    </>
  );
}
