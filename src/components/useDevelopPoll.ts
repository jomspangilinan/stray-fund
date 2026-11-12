"use client";

import { useEffect, useState } from "react";
import { forSighting, pollDeveloped, type DevelopStatus, type Tagged } from "@/lib/developPoll";

export type Developing = { developed: boolean; soon: boolean; photoUrl: string | null; avatar: DevelopStatus["avatar"] | null };

const FRESH: Developing = { developed: false, soon: false, photoUrl: null, avatar: null };

/** Watches one of the person's own photos until it is developed. Off, or with no id, it reports nothing to wait for. */
export function useDevelopPoll(sightingId: string | null, enabled: boolean): Developing {
  // Tagged with the photo it came from: SpotFlow stays mounted across "Keep spotting", and a second photo must not inherit the first's.
  const [stored, setStored] = useState<Tagged<Developing>>({ id: null, value: FRESH });
  const set = (id: string, f: (d: Developing) => Developing) =>
    setStored((s) => ({ id, value: f(s.id === id ? s.value : FRESH) }));
  useEffect(() => {
    if (!enabled || !sightingId) return;
    const ac = new AbortController();
    void pollDeveloped(
      async () => {
        const res = await fetch(`/api/spot/${sightingId}`, { cache: "no-store", signal: ac.signal });
        if (res.status === 401 || res.status === 403 || res.status === 404) return "stop";
        if (!res.ok) return null;
        return (await res.json()) as DevelopStatus;
      },
      {
        signal: ac.signal,
        onSoon: () => set(sightingId, (s) => ({ ...s, soon: true })),
      },
    ).then((out) => {
      if (out.kind === "developed") {
        set(sightingId, (s) => ({ ...s, developed: true, photoUrl: out.status.photoUrl, avatar: out.status.avatar }));
      }
    });
    return () => ac.abort();
  }, [sightingId, enabled]);
  return forSighting(stored, sightingId, FRESH);
}
