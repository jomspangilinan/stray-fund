/*
 * Building the keepsake takes a few seconds, and a share sheet needs the tap that opens it. So the picture is
 * built ahead of the tap by a job that cannot hang: it has one overall limit, and a stalled build is aborted.
 */

export type JobState = "idle" | "building" | "ready" | "failed";
export const BUILD_LIMIT_MS = 20_000;

export function createJob(build: (signal: AbortSignal) => Promise<File>, limitMs: number = BUILD_LIMIT_MS) {
  let state: JobState = "idle";
  let made: File | null = null;
  let run = 0;
  const listeners = new Set<() => void>();
  const set = (next: JobState) => {
    state = next;
    listeners.forEach((l) => l());
  };

  function go() {
    const mine = ++run;
    const ctl = new AbortController();
    made = null;
    set("building");
    const timer = setTimeout(() => {
      if (mine !== run || state !== "building") return;
      ctl.abort();
      set("failed");
    }, limitMs);
    build(ctl.signal).then(
      (f) => {
        clearTimeout(timer);
        if (mine !== run || state !== "building") return;
        made = f;
        set("ready");
      },
      () => {
        clearTimeout(timer);
        if (mine !== run || state !== "building") return;
        set("failed");
      },
    );
  }

  return {
    state: () => state,
    file: () => made,
    /** Starts the first build. Calling it again does nothing. */
    start() {
      if (state === "idle") go();
    },
    /** Starts over after a failure. */
    retry() {
      if (state === "failed") go();
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
}

type Sharer = { canShare?: (d: { files: File[] }) => boolean; share?: (d: { files: File[] }) => Promise<void> };

/**
 * Hands the finished picture over. The share call is the first thing that happens, with nothing awaited before it,
 * because iPhone Safari ends the tap's permission within about a second. A dismissed sheet is done; a lost
 * permission says "again" with the picture still in hand; anything else falls back to a download.
 */
export function handOver(file: File, nav: Sharer | undefined, download: (f: File) => void): Promise<"done" | "again"> {
  let sharing: Promise<void> | null = null;
  if (nav?.share && nav.canShare?.({ files: [file] })) sharing = nav.share({ files: [file] });
  return (async () => {
    if (sharing) {
      try {
        await sharing;
        return "done" as const;
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return "done" as const;
        if (e instanceof DOMException && e.name === "NotAllowedError") return "again" as const;
      }
    }
    download(file);
    return "done" as const;
  })();
}
