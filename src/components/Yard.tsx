import Link from "next/link";
import type { PublicYard } from "@/server/public";
import { jitterFor, placeAt, slotsFor, tagName, yardScale, yardSlots } from "@/lib/yard";
import { CatAvatar } from "./CatAvatar";
import { YardScene } from "./YardScene";
import { YardStage } from "./YardStage";

/**
 * The home picture: one made-up courtyard. Cats stand where a hash of their id puts them and every cat is a
 * real link. A signed-out visitor also gets one line on what this is. The goal sits on top; each cat wears an always-visible name tag. Motion is light CSS that pauses when hidden.
 */
export function Yard({ yard, intro = false }: { yard: PublicYard; intro?: boolean }) {
  const { cats, total, stage, goal } = yard;
  const slots = slotsFor(cats.map((c) => c.id));
  const places = yardSlots(cats.length);
  const scale = yardScale(cats.length);
  return (
    <section aria-labelledby="yard-title" className="yard on-main">
      <div className="yard-goal">
        <div className="flex items-center justify-between gap-3">
          <h2 id="yard-title" className="yard-count">
            {goal.neutered} of {goal.goal} neutered
          </h2>
          {total > 0 && (
            <Link href="/cats" className="link !text-white underline flex-none">
              See all {total}
            </Link>
          )}
        </div>
        {intro && <p className="yard-intro">Neighbours fund neutering for stray cats. The money is shown in the open.</p>}
        <div
          className="goal-bar"
          role="progressbar"
          aria-label="Cats neutered"
          aria-valuemin={0}
          aria-valuemax={goal.goal}
          aria-valuenow={Math.min(goal.neutered, goal.goal)}
        >
          <i style={{ width: `${goal.percent}%` }} />
        </div>
      </div>
      <YardStage className="yard-stage">
        <YardScene stage={stage} />
        {cats.length === 0 ? (
          <div className="yard-empty">
            <p className="font-bold">No cats yet</p>
            <Link href="/spot" className="btn-pop">
              Spot a cat
            </Link>
          </div>
        ) : (
          <ul className="yard-cats" aria-label="Cats in the yard">
            {cats.map((c) => {
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
                    <span className="yard-name" aria-hidden="true">
                      {tagName(c.name)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </YardStage>
    </section>
  );
}

export function YardSkeleton() {
  return (
    <div className="yard yard-loading" role="status" aria-label="Loading the yard">
      <div className="yard-goal">
        <span className="skeleton block h-6 w-2/5" aria-hidden="true" />
        <span className="skeleton mt-2 block h-3 w-full" aria-hidden="true" />
      </div>
      <div className="yard-stage skeleton !rounded-none" aria-hidden="true" />
      <span className="sr-only">Loading the yard</span>
    </div>
  );
}
