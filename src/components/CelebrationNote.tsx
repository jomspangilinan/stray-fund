"use client";

import { useEffect } from "react";

/** Shows the one note, then tells the server it was seen. A reload before that still shows it. */
export function CelebrationNote({ text, catId, milestone }: { text: string; catId: string; milestone: string }) {
  useEffect(() => {
    fetch("/api/helped/seen", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ catId, milestone }),
    }).catch(() => {});
  }, [catId, milestone]);
  return (
    <p className="note note-ok mt-6 font-bold" role="status">
      {text}
    </p>
  );
}
