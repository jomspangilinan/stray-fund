import Link from "next/link";
import type { PublicYard } from "@/server/public";
import { YardScene } from "./YardScene";
import { YardStage } from "./YardStage";
import { YardStrip } from "./YardStrip";

/**
 * The home picture: a made-up courtyard, a section for every ten cats, with arrows and zoom (YardStrip). Cats
 * stand where a hash of their id puts them and every cat is a real link. A signed-out visitor also gets one line on what this is. The goal sits on top; each cat wears an always-visible name tag. Motion is light CSS that pauses when hidden.
 */
export function Yard({ yard, intro = false }: { yard: PublicYard; intro?: boolean }) {
  const { cats, total, stage, goal } = yard;
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
        {intro && <p className="yard-intro">Neighbours fund spay and neuter for stray cats. The money is shown in the open.</p>}
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
      {cats.length === 0 ? (
        <YardStage className="yard-stage">
          <YardScene stage={stage} />
          <div className="yard-empty">
            <p className="font-bold">No cats yet</p>
            <Link href="/spot" className="btn-pop">
              Spot a cat
            </Link>
          </div>
        </YardStage>
      ) : (
        <YardStrip cats={cats} stage={stage} />
      )}
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
