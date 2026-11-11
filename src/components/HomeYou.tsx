import Link from "next/link";
import { streakLabel } from "@/lib/streak";
import { getHomeThanks } from "@/server/thanks";
import { getNews } from "@/server/news";
import { getStreak } from "@/server/streak";
import { getSession } from "@/server/session";
import { NewsList } from "./NewsList";

/** News and the weekly count for the signed-in person. Signed out, it just invites a first spot. */
export async function HomeYou() {
  // The same thanks can come from two events (two neighbours confirming one ear-tip); say it once.
  const thanks = [...new Map((await getHomeThanks()).map((t) => [`${t.name} ${t.text}`, t])).entries()];
  const session = await getSession();
  const strip = thanks.length > 0 && (
    <section className="mt-8" aria-labelledby="thanks-title">
      <h2 id="thanks-title" className="h2">
        Thanks, neighbours
      </h2>
      <ul className="mt-2 flex flex-wrap gap-2">
        {thanks.map(([key, t]) => (
          <li key={key} className="small rounded-in bg-surface px-3 py-1.5">
            <strong>{t.name}</strong> {t.text}
          </li>
        ))}
      </ul>
    </section>
  );
  if (!session) {
    return (
      <>
      <section className="mt-8" aria-labelledby="news-title">
        <h2 id="news-title" className="h2">
          News about your cats
        </h2>
        <div className="card mt-2 flex items-center justify-between gap-3">
          <p className="font-bold">Sign in to see it.</p>
          <Link href="/spot" className="btn flex-none">
            Spot a cat
          </Link>
        </div>
      </section>
      {strip}
      </>
    );
  }
  const [news, streak] = await Promise.all([getNews(session.userId), getStreak(session.userId)]);
  const label = streakLabel(streak);
  return (
    <>
    <section className="mt-8" aria-labelledby="news-title">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="news-title" className="h2">
          News about your cats
        </h2>
        {label && <p className="small font-bold text-main">{label}</p>}
      </div>
      <div className="mt-2">
        {news.items.length > 0 ? (
          <NewsList items={news.items} upTo={news.upTo} />
        ) : (
          <div className="card flex items-center justify-between gap-3">
            <p className="font-bold">Nothing new yet.</p>
            <Link href="/spot" className="btn flex-none">
              Spot a cat
            </Link>
          </div>
        )}
      </div>
    </section>
    {strip}
    </>
  );
}
