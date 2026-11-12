"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import {
  ZOOM_LEVELS,
  jitterFor,
  placeAt,
  screenOf,
  screensAt,
  screensToDraw,
  sectionScale,
  slotsFor,
  tagName,
  yardSections,
  yardSlots,
  type YardCat,
  type Zoom,
} from "@/lib/yard";
import { sectionLook } from "@/lib/yardLook";
import { CatAvatar } from "./CatAvatar";
import { YardScene } from "./YardScene";
import { YardStage } from "./YardStage";

/** A sideways swipe on the yard longer than this walks to the next screen. */
const SWIPE_PX = 50;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The yard, as wide as the colony needs: a section of courtyard for every ten cats, all vector. The arrows at
 * the edges (or a swipe) walk along it. Zoom out to see 2 x 2 or 3 x 3 sections at once; tap a section, or zoom
 * in, to go back to one. Only the screen on show and its neighbours are drawn (zoomed out, only the screen on
 * show, with the cats standing still), so a hundred cats cost what twenty do. Every cat is a real link to its page.
 */
export function YardStrip({ cats, stage }: { cats: YardCat[]; stage: 0 | 1 | 2 | 3 }) {
  const sections = yardSections(cats);
  const n = sections.length;
  const [zoom, setZoom] = useState<Zoom>(1);
  const [chosen, setScreen] = useState(0);
  const per = zoom * zoom;
  const screens = screensAt(n, zoom);
  const screen = Math.min(chosen, screens - 1);
  const swipe = useRef<{ x: number; y: number } | null>(null);

  const zoomTo = (z: Zoom, section: number = screen * per) => {
    setZoom(z);
    setScreen(screenOf(clamp(section, 0, n - 1), z));
  };
  const zoomIndex = ZOOM_LEVELS.indexOf(zoom);
  // No point zooming out further than shows every section at once.
  const canZoomOut = zoomIndex < ZOOM_LEVELS.length - 1 && n > per;
  const canZoomIn = zoomIndex > 0;

  return (
    <YardStage className="yard-stage">
      <div
        className="yard-strip"
        data-zoom={zoom}
        style={{ transform: `translateX(-${screen * 100}%)` }}
        onPointerDown={(e) => (swipe.current = { x: e.clientX, y: e.clientY })}
        onPointerUp={(e) => {
          const s = swipe.current;
          swipe.current = null;
          if (!s) return;
          const dx = e.clientX - s.x;
          if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(e.clientY - s.y)) setScreen(clamp(screen + (dx < 0 ? 1 : -1), 0, screens - 1));
        }}
      >
        {/* Zoomed out, only the screen on show: up to ninety still cats, never three screens of them. */}
        {(zoom === 1 ? screensToDraw(screen, screens) : [screen]).map((s) => (
          <div
            key={`${zoom}:${s}`}
            className="yard-screen"
            style={{ left: `${s * 100}%`, gridTemplateColumns: `repeat(${zoom}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${zoom}, minmax(0, 1fr))` }}
            aria-hidden={s !== screen ? true : undefined}
            inert={s !== screen ? true : undefined}
          >
            {sections.slice(s * per, (s + 1) * per).map((list, j) => {
              const k = s * per + j;
              const slots = slotsFor(list.map((c) => c.id));
              const places = yardSlots(list.length);
              const scale = sectionScale(n, list.length);
              return (
                <div key={k} className="yard-section">
                  <YardScene stage={stage} look={sectionLook(k)} bowl={k === 0} />
                  <ul className="yard-cats" aria-label={n > 1 ? `Cats, part ${k + 1} of ${n}` : "Cats in the yard"} inert={zoom > 1 ? true : undefined}>
                    {list.map((c) => {
                      const spot = placeAt(places[slots.get(c.id) ?? 0], scale);
                      const dir = jitterFor(c.id, 1) < 0.5 ? -1 : 1;
                      const style = {
                        left: `${spot.x.toFixed(2)}%`,
                        top: `${spot.y.toFixed(2)}%`,
                        width: `${spot.w.toFixed(2)}%`,
                        zIndex: Math.round(spot.y),
                        "--dx": `${(dir * (10 + jitterFor(c.id, 2) * 10)).toFixed(0)}%`,
                        "--dur": `${(22 + jitterFor(c.id, 3) * 14).toFixed(1)}s`,
                        "--off": `${(-jitterFor(c.id, 4) * 30).toFixed(1)}s`,
                        "--breath": `${(4.2 + jitterFor(c.id, 5) * 1.8).toFixed(1)}s`,
                      } as React.CSSProperties;
                      return (
                        <li key={c.id} className="yard-cat" style={style} data-group={c.group}>
                          <Link href={`/cats/${c.id}`} className="yard-link" aria-label={`${c.name}, ${c.statusLabel}`}>
                            <span className="yard-bob">
                              <CatAvatar avatar={c.avatar} id={c.id} marks={c.marks} ribbon={c.female} />
                            </span>
                            {c.yours && <span className="yard-yours">Yours</span>}
                            <span className="yard-name" aria-hidden="true">
                              {tagName(c.name)}
                            </span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                  {zoom > 1 && (
                    <button type="button" className="yard-section-open" aria-label={`Zoom in to part ${k + 1} of ${n}, ${list.length} ${list.length === 1 ? "cat" : "cats"}`} onClick={() => zoomTo(1, k)} />
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {screens > 1 && (
        <>
          <button type="button" className="yard-arrow yard-arrow-left" aria-label="Walk left in the yard" disabled={screen === 0} onClick={() => setScreen(screen - 1)}>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
          <button type="button" className="yard-arrow yard-arrow-right" aria-label="Walk right in the yard" disabled={screen === screens - 1} onClick={() => setScreen(screen + 1)}>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>
          <p className="yard-where" aria-live="polite">
            <span className="sr-only">Screen </span>
            {screen + 1} / {screens}
          </p>
        </>
      )}
      {n > 1 && (
        <div className="yard-zoom" role="group" aria-label="Zoom">
          <button type="button" aria-label="Zoom in: fewer cats, bigger" disabled={!canZoomIn} onClick={() => zoomTo(ZOOM_LEVELS[zoomIndex - 1])}>
            +
          </button>
          <button type="button" aria-label="Zoom out: more cats at once" disabled={!canZoomOut} onClick={() => zoomTo(ZOOM_LEVELS[zoomIndex + 1])}>
            −
          </button>
        </div>
      )}
    </YardStage>
  );
}
