"use client";

import { useEffect, useState } from "react";
import { pollDeveloped, type DevelopStatus } from "@/lib/developPoll";

export type Developing = { developed: boolean; soon: boolean; photoUrl: string | null; avatar: DevelopStatus["avatar"] | null };

/** Watches one of the person's own photos until it is developed. Off, or with no id, it reports nothing to wait for. */
export function useDevelopPoll(sightingId: string | null, enabled: boolean): Developing {
  const [state, setState] = useState<Developing>({ developed: false, soon: false, photoUrl: null, avatar: null });
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
        onSoon: () => setState((s) => ({ ...s, soon: true })),
      },
    ).then((out) => {
      if (out.kind === "developed") {
        setState((s) => ({ ...s, developed: true, photoUrl: out.status.photoUrl, avatar: out.status.avatar }));
      }
    });
    return () => ac.abort();
  }, [sightingId, enabled]);
  return state;
}
