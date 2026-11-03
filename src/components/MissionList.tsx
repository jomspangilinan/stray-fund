"use client";

import Link from "next/link";
import { useState } from "react";
import type { Mission } from "@/lib/missions";
import { CatPhoto } from "./CatPhoto";

/** Opens the share sheet with the public card link, or copies the link when sharing is not available. */
async function shareCard(catId: string, name: string): Promise<"shared" | "copied" | "failed"> {
  const url = `${window.location.origin}/cats/${catId}`;
  try {
    if (typeof navigator.share === "function") {
      await navigator.share({ title: name, url });
      return "shared";
    }
    await navigator.clipboard.writeText(url);
    return "copied";
  } catch (e) {
    // Closing the share sheet is not an error.
    return e instanceof DOMException && e.name === "AbortError" ? "shared" : "failed";
  }
}

function nameOf(m: Mission): string {
  return m.title.replace(/^Help (find )?/, "").replace(/ find a home$/, "") || "this cat";
}

export function MissionList({ missions }: { missions: Mission[] }) {
  const [note, setNote] = useState<Record<string, string>>({});
  return (
    <ul className="list">
      {missions.map((m) => (
        <li key={`${m.kind}-${m.catId}`}>
          <div className="row">
            <Link href={`/cats/${m.catId}`} className="relative h-20 w-20 flex-none overflow-hidden rounded-out" aria-label={`Open ${nameOf(m)}'s card`}>
              <CatPhoto url={m.photoUrl} name={nameOf(m)} sizes="80px" />
            </Link>
            <div className="min-w-0 flex-1">
              <p className="font-bold leading-tight">{m.title}</p>
              <p className="small soft">{note[m.catId] ?? m.detail}</p>
            </div>
            {m.action === "spot" ? (
              <Link href="/spot" className="btn-quiet !min-h-11 flex-none">
                Spot
              </Link>
            ) : (
              <button
                type="button"
                className="btn-quiet !min-h-11 flex-none"
                onClick={async () => {
                  const r = await shareCard(m.catId, nameOf(m));
                  if (r === "copied") setNote((n) => ({ ...n, [m.catId]: "Link copied." }));
                  if (r === "failed") setNote((n) => ({ ...n, [m.catId]: "Could not share. Try again." }));
                }}
              >
                Share
              </button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
