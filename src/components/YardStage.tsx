"use client";

import { useEffect, useRef } from "react";

/**
 * Holds the yard picture and pauses its motion while the page is hidden or the yard is off screen,
 * so a phone in a pocket or a scrolled-away yard costs nothing.
 */
export function YardStage({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let hidden = document.hidden;
    let away = false;
    const apply = () => el.setAttribute("data-paused", String(hidden || away));
    const onVisibility = () => {
      hidden = document.hidden;
      apply();
    };
    document.addEventListener("visibilitychange", onVisibility);
    const io = typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => {
          away = !entries[entries.length - 1].isIntersecting;
          apply();
        })
      : null;
    io?.observe(el);
    apply();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      io?.disconnect();
    };
  }, []);
  return (
    <div ref={ref} className={className} data-paused="false">
      {children}
    </div>
  );
}
