import Link from "next/link";
import type { GoalProgress, PublicCat } from "@/server/public";
import { CatPhoto } from "./CatPhoto";

/** The home picture: the neighbourhood's cats and the shared goal. Progress achieved, never a shortfall. */
export function HeroGoal({ goal, cats }: { goal: GoalProgress; cats: PublicCat[] }) {
  const shown = cats.slice(0, 4);
  return (
    <section aria-labelledby="goal-title" className="goal hero on-main">
      {shown.length > 0 && (
        <ul className={`hero-mosaic ${shown.length === 1 ? "one" : ""}`} aria-label="Cats around the neighbourhood">
          {shown.map((c) => (
            <li key={c.id}>
              <Link href={`/cats/${c.id}`} className="press relative block h-full w-full" aria-label={c.name}>
                <CatPhoto url={c.photoUrl} name={c.name} sizes="(min-width: 576px) 16rem, 45vw" />
              </Link>
            </li>
          ))}
        </ul>
      )}
      <h2 id="goal-title" className="mt-4 text-2xl font-extrabold leading-tight tracking-tight">
        {goal.neutered} of {goal.goal} cats neutered
      </h2>
      <div
        className="goal-bar mt-3"
        role="progressbar"
        aria-label="Cats neutered"
        aria-valuemin={0}
        aria-valuemax={goal.goal}
        aria-valuenow={Math.min(goal.neutered, goal.goal)}
      >
        <i style={{ width: `${goal.percent}%` }} />
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="small">{goal.area}</p>
        <Link href="/missions" className="link !text-white underline">
          Missions
        </Link>
      </div>
    </section>
  );
}
