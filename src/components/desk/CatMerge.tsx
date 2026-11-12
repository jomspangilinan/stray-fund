"use client";

import { useState } from "react";
import { ActionForm } from "../ActionForm";
import { CatPhoto } from "../CatPhoto";
import { Hidden } from "./Fields";

export type MergeChoice = { id: string; name: string; photoUrl: string | null };

/**
 * "Same cat as…", for a cat a plain public photo added a second time. The first tap picks the real cat from a list
 * of the others, the second sends. The server checks the same rules as Remove again.
 */
export function CatMerge({ cat, others }: { cat: { id: string; name: string }; others: MergeChoice[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pick, setPick] = useState<MergeChoice | null>(null);

  if (others.length === 0) return null;
  if (!open) {
    return (
      <div className="mt-3 grid">
        <button type="button" className="btn-quiet" onClick={() => setOpen(true)}>
          Same cat as…
        </button>
      </div>
    );
  }

  if (pick) {
    return (
      <div className="note mt-3 grid gap-2">
        <p className="font-bold break-words">
          Same cat as {pick.name}? {cat.name}&apos;s photos move to {pick.name}, and {cat.name}&apos;s card goes. This can&apos;t be undone.
        </p>
        <ActionForm action="cat_merge" submitLabel={`Yes, same cat as ${pick.name}`}>
          <Hidden name="catId" value={cat.id} />
          <Hidden name="intoCatId" value={pick.id} />
        </ActionForm>
        <button type="button" className="btn-quiet" onClick={() => setPick(null)}>
          Choose another cat
        </button>
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  const shown = q ? others.filter((o) => o.name.toLowerCase().includes(q)) : others;
  return (
    <div className="mt-3 grid gap-2">
      <label className="grid gap-1">
        <span className="font-bold">Which cat is {cat.name} really?</span>
        <input type="search" className="field" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name" />
      </label>
      {shown.length === 0 ? (
        <p className="small soft">No cat by that name.</p>
      ) : (
        <ul className="grid max-h-80 gap-1 overflow-y-auto">
          {shown.map((o) => (
            <li key={o.id}>
              <button type="button" className="flex min-h-11 w-full items-center gap-3 rounded-in p-1 text-left" onClick={() => setPick(o)}>
                <span className="relative h-10 w-10 flex-none overflow-hidden rounded-in">
                  <CatPhoto url={o.photoUrl} name={o.name} sizes="40px" />
                </span>
                <span className="min-w-0 break-words font-bold">{o.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="btn-quiet" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </div>
  );
}
