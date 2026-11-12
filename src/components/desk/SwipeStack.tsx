"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { SwipeCard, SwipeMove } from "@/lib/swipeCards";
import { RotateButtons } from "../SightingPhoto";
import { ToneNote, type ReplyTone } from "./ToneNote";

const UNDO_MS = 5000;
/** How far a drag must go, as a share of the card's width, before letting go counts as a swipe. */
const SWIPE_SHARE = 0.3;

type Pending = { card: SwipeCard; move: SwipeMove; timer: ReturnType<typeof setTimeout> };
type Reply = { ok?: boolean; message?: string; tone?: ReplyTone };

const KIND_LABEL: Record<SwipeCard["kind"], string> = { report: "Report", approval: "Payment", receipt: "Receipt", eartip: "Ear tip after surgery", ears: "Ear tip", name: "Name" };

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The card's photo. One that can't load (it may fail before the page is interactive) leaves no empty frame. A
 * sighting's photo also gets Rotate left and Rotate right, for one that came out sideways.
 */
function CardPhoto({ src, sightingId }: { src: string; sightingId: string | null }) {
  const ref = useRef<HTMLImageElement>(null);
  const [version, setVersion] = useState(0);
  // Rotate shows only once the photo has loaded: there is nothing to turn by eye in a photo that can't be seen.
  const [loaded, setLoaded] = useState(false);
  const shown = version ? `${src}?r=${version}` : src;
  useEffect(() => {
    const img = ref.current;
    if (img && img.complete && img.naturalWidth === 0) img.hidden = true;
    else if (img && img.complete) setLoaded(true);
  }, [shown]);
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element -- a private photo behind a signed-in route */}
      <img
        ref={ref}
        src={shown}
        alt=""
        draggable={false}
        onLoad={() => setLoaded(true)}
        onError={(e) => {
          e.currentTarget.hidden = true;
          setLoaded(false);
        }}
        className="mt-3 h-52 w-full rounded-in bg-pale object-cover"
      />
      {sightingId && loaded && <RotateButtons sightingId={sightingId} onTurned={() => setVersion((v) => v + 1)} />}
    </>
  );
}

/**
 * The caretaker's cards, one decision at a time. Right is the green action, left the other one. A swipe waits
 * five seconds with an Undo before it posts to the same route today's form uses; the server checks everything again.
 */
export function SwipeStack({
  cards,
  forms,
  alsoWaiting,
}: {
  cards: SwipeCard[];
  /** Each card's full form from today's desk, by card id, for "Change something". */
  forms: Record<string, React.ReactNode>;
  alsoWaiting: number;
}) {
  const router = useRouter();
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Pending | null>(null);
  const [notice, setNotice] = useState<{ tone: ReplyTone; message: string } | null>(null);
  const [dx, setDx] = useState(0);
  const [leaving, setLeaving] = useState<"left" | "right" | null>(null);
  const drag = useRef<{ x: number; id: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const pendingRef = useRef<Pending | null>(null);
  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  const visible = cards.filter((c) => !gone.has(c.id));
  const top = visible[0] ?? null;
  const next = visible[1] ?? null;

  const post = useCallback(
    async (p: Pending) => {
      try {
        const res = await fetch(`/api/caretaker/${p.move.action}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(p.move.body),
          keepalive: true,
        });
        const json = (await res.json().catch(() => ({}))) as Reply;
        const worked = res.ok && json.ok === true;
        const message = json.message ?? (worked ? "Done." : "Something went wrong. Try again.");
        if (!worked) {
          // Nothing changed on the server: the card comes back on top with the reason.
          setGone((g) => {
            const n = new Set(g);
            n.delete(p.card.id);
            return n;
          });
          setNotice({ tone: "bad", message: `${p.card.title}: ${message}` });
          return;
        }
        setNotice({ tone: json.tone ?? "ok", message });
        router.refresh();
      } catch {
        setGone((g) => {
          const n = new Set(g);
          n.delete(p.card.id);
          return n;
        });
        setNotice({ tone: "bad", message: "Could not reach the server. The card is back; try again." });
      }
    },
    [router],
  );

  const flush = useCallback(() => {
    const p = pendingRef.current;
    if (!p) return;
    clearTimeout(p.timer);
    setPending(null);
    void post(p);
  }, [post]);

  // Leaving the page inside the five seconds still sends what was swiped.
  useEffect(() => () => flush(), [flush]);

  function swipe(dir: "left" | "right") {
    if (!top || leaving) return;
    const move = dir === "right" ? top.right : top.left;
    if (!move) {
      // This choice needs words, so it opens the full form instead of sending.
      setDx(0);
      setEditing(top.id);
      return;
    }
    flush();
    setNotice(null);
    const card = top;
    const finish = () => {
      setLeaving(null);
      setDx(0);
      setGone((g) => new Set(g).add(card.id));
      const timer = setTimeout(() => {
        setPending((cur) => (cur && cur.card.id === card.id ? null : cur));
        void post({ card, move, timer });
      }, UNDO_MS);
      setPending({ card, move, timer });
    };
    if (reducedMotion()) finish();
    else {
      setLeaving(dir);
      setTimeout(finish, 180);
    }
  }

  function undo() {
    const p = pendingRef.current;
    if (!p) return;
    clearTimeout(p.timer);
    setPending(null);
    setGone((g) => {
      const n = new Set(g);
      n.delete(p.card.id);
      return n;
    });
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    // Buttons and links inside the card keep their own taps.
    if ((e.target as HTMLElement).closest("button, a")) return;
    drag.current = { x: e.clientX, id: e.pointerId };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (drag.current?.id === e.pointerId) setDx(e.clientX - drag.current.x);
  }
  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
    const width = cardRef.current?.offsetWidth ?? 320;
    if (Math.abs(dx) > width * SWIPE_SHARE) swipe(dx > 0 ? "right" : "left");
    else setDx(0);
  }

  const offset = leaving === "right" ? 600 : leaving === "left" ? -600 : dx;
  const lean = Math.max(-1, Math.min(1, dx / 160));

  return (
    <section aria-label="Swipe to check" className="mt-4">
      {top && editing === top.id ? (
        <div className="card">
          <div className="flex items-center justify-between gap-3">
            <p className="small font-bold text-main">{KIND_LABEL[top.kind]}</p>
            <button type="button" onClick={() => setEditing(null)} className="btn-quiet !min-h-11 !px-3.5">
              Back to the card
            </button>
          </div>
          {/* Today's full form, with its own heading hidden: the card already says what this is. */}
          <div className="[&_section]:mt-2 [&_section>h2]:sr-only [&_li.card]:p-0 [&_li.card]:shadow-none">{forms[top.id]}</div>
        </div>
      ) : top ? (
        <>
          <p className="small soft mb-2" aria-live="polite">
            {visible.length} to check. Swipe right to {top.right.label.toLowerCase()}, left to {top.leftLabel.toLowerCase()}.
          </p>
          <div className="relative">
            {next && <div aria-hidden="true" className="card absolute inset-x-3 -bottom-2 top-3 opacity-60" />}
            <div
              ref={cardRef}
              tabIndex={0}
              role="group"
              aria-label={`${KIND_LABEL[top.kind]}, ${top.title}`}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === "ArrowRight") swipe("right");
                if (e.key === "ArrowLeft") swipe("left");
              }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => {
                drag.current = null;
                setDragging(false);
                setDx(0);
              }}
              style={{ transform: `translateX(${offset}px) rotate(${offset / 24}deg)`, touchAction: "pan-y" }}
              className={`card relative select-none outline-none focus-visible:ring-4 focus-visible:ring-pale ${dragging ? "" : "transition-transform duration-200 motion-reduce:transition-none"}`}
            >
              {lean !== 0 && (
                <span
                  aria-hidden="true"
                  style={{ opacity: Math.abs(lean) }}
                  className={`absolute top-4 z-10 rounded-in px-3 py-1 font-extrabold ${lean > 0 ? "left-4 bg-main text-white" : "right-4 bg-ink text-white"}`}
                >
                  {lean > 0 ? top.right.label : top.leftLabel}
                </span>
              )}
              <p className="small font-bold text-main">{KIND_LABEL[top.kind]}</p>
              <h2 className="mt-0.5 text-xl font-extrabold">{top.title}</h2>
              {top.photo && (
                <CardPhoto key={top.photo} src={top.photo} sightingId={top.sightingId} />
              )}
              <ul className="mt-3 grid gap-1 small">
                {top.facts.map((f) => (
                  <li key={f} className="break-words">
                    {f}
                  </li>
                ))}
              </ul>
              <div className="mt-3 rounded-in bg-pale p-3">
                <p className="small font-extrabold text-main">{top.aiLabel}</p>
                <p className="mt-1 break-words">{top.ai}</p>
                {top.suggest && (
                  <p className="mt-2 small font-bold">Suggests: {top.suggest === "right" ? top.right.label : top.leftLabel}</p>
                )}
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2">
                <button type="button" className="btn-quiet" onClick={() => swipe("left")}>
                  ← {top.leftLabel}
                </button>
                <button type="button" className="btn" onClick={() => swipe("right")}>
                  {top.right.label} →
                </button>
              </div>
              <button type="button" onClick={() => setEditing(top.id)} className="press mt-2 min-h-11 w-full rounded-in small font-bold text-main">
                Change something
              </button>
            </div>
          </div>
        </>
      ) : (
        <div className="card text-center">
          <h2 className="title">All checked</h2>
          <p className="mt-1 soft">
            {alsoWaiting > 0 ? `${alsoWaiting} more ${alsoWaiting === 1 ? "thing needs" : "things need"} a closer look below.` : "Nothing else is waiting."}
          </p>
        </div>
      )}

      <div role="status" className="mt-3 grid gap-2">
        {pending && (
          <div className="flex items-center justify-between gap-3 rounded-in bg-ink px-4 py-2 text-white">
            <span className="small font-bold">
              {pending.move.label}: sending in 5 seconds
            </span>
            <button type="button" onClick={undo} className="press min-h-11 rounded-in px-3 font-extrabold text-pop">
              Undo
            </button>
          </div>
        )}
        {notice && <ToneNote tone={notice.tone} message={notice.message} />}
      </div>
    </section>
  );
}
