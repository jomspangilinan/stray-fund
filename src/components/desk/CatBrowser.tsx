"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

const SWIPE_PX = 90;

/**
 * Every cat, one at a time. Swiping here only moves between cats; it decides nothing. The arrows and the ← → keys
 * do the same. What is on the card comes from the server, so each cat loads its own timeline.
 */
export function CatBrowser({
  position,
  total,
  prevHref,
  nextHref,
  children,
}: {
  position: number;
  total: number;
  prevHref: string;
  nextHref: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const [dx, setDx] = useState(0);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    // Forms, buttons and links inside the card keep their own taps.
    if ((e.target as HTMLElement).closest("button, a, input, select, textarea, label, summary")) return;
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const s = start.current;
    if (!s || s.id !== e.pointerId) return;
    const x = e.clientX - s.x;
    // A mostly vertical move is a scroll, not a swipe.
    if (Math.abs(x) > Math.abs(e.clientY - s.y)) setDx(x);
  }
  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (start.current?.id !== e.pointerId) return;
    start.current = null;
    const moved = dx;
    setDx(0);
    if (moved <= -SWIPE_PX) router.push(nextHref, { scroll: false });
    else if (moved >= SWIPE_PX) router.push(prevHref, { scroll: false });
  }

  return (
    <div
      className="mt-4"
      onKeyDown={(e) => {
        const tag = (e.target as HTMLElement).tagName;
        if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
        if (e.key === "ArrowRight") router.push(nextHref, { scroll: false });
        if (e.key === "ArrowLeft") router.push(prevHref, { scroll: false });
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <Link href={prevHref} scroll={false} aria-label="Previous cat" className="btn-quiet !min-h-11 !px-4">
          ←
        </Link>
        <p className="small soft" aria-live="polite">
          Cat {position} of {total}. Swipe to look through them.
        </p>
        <Link href={nextHref} scroll={false} aria-label="Next cat" className="btn-quiet !min-h-11 !px-4">
          →
        </Link>
      </div>
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          start.current = null;
          setDx(0);
        }}
        style={{ transform: `translateX(${dx}px)`, touchAction: "pan-y" }}
        className={`card mt-3 ${dx === 0 ? "transition-transform duration-200 motion-reduce:transition-none" : ""}`}
      >
        {children}
      </div>
    </div>
  );
}
