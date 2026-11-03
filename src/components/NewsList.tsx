"use client";

import Link from "next/link";
import { useEffect } from "react";
import type { NewsItem } from "@/server/news";

const dateFormat = new Intl.DateTimeFormat("en-PH", { timeZone: "UTC", day: "numeric", month: "short" });
const niceDate = (iso: string) => dateFormat.format(new Date(`${iso}T00:00:00Z`));

/** The list stays until the browser has shown it and told the server. A reload before that shows it again. */
export function NewsList({ items, upTo }: { items: NewsItem[]; upTo: string | null }) {
  useEffect(() => {
    if (!upTo) return;
    fetch("/api/news/seen", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ upTo }),
    }).catch(() => {});
  }, [upTo]);
  return (
    <ul className="list">
      {items.map((i, k) => (
        <li key={`${i.catId}-${k}`}>
          <Link href={`/cats/${i.catId}`} className="press row">
            <span className="min-w-0 flex-1 font-bold leading-tight">{i.text}</span>
            <span className="small soft flex-none">{niceDate(i.date)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
