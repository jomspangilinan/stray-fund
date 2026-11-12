"use client";

import { useRef } from "react";

/** A small photo that opens full size over the page. Close with the button, Escape, or a tap outside the photo. */
export function PhotoZoom({ url, name, children }: { url: string | null; name: string; children: React.ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  if (!url) return <>{children}</>;
  return (
    <>
      <button type="button" onClick={() => dialog.current?.showModal()} aria-label={`Show ${name}'s photo bigger`} className="press block h-full w-full">
        {children}
      </button>
      <dialog
        ref={dialog}
        onClick={(e) => {
          if (e.target === e.currentTarget) dialog.current?.close();
        }}
        className="m-auto max-h-[90dvh] w-[min(40rem,calc(100vw-2rem))] rounded-out bg-surface p-3 backdrop:bg-ink/70"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- the same public photo, shown full size */}
        <img src={url} alt={`${name}, a stray cat`} className="max-h-[75dvh] w-full rounded-in object-contain" />
        <button type="button" onClick={() => dialog.current?.close()} className="btn-quiet mt-3 w-full">
          Close
        </button>
      </dialog>
    </>
  );
}
