import Link from "next/link";
import type { GoalProgress } from "@/server/public";

/** Progress achieved, as a bar and one line. Never a shortfall. */
export function GoalCard({ goal, href }: { goal: GoalProgress; href?: string }) {
  const body = (
    <>
      <p className="text-xl font-extrabold leading-tight tracking-tight">
        {goal.neutered} of {goal.goal} cats neutered
      </p>
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
      <p className="small mt-2">{goal.area}</p>
    </>
  );
  return href ? (
    <Link href={href} className="goal press block">
      {body}
    </Link>
  ) : (
    <section className="goal">{body}</section>
  );
}
