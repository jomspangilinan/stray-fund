import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SCAN_STEPS, STEP_MS, scanProgress } from "../src/lib/scanSteps";
import { ScanChecklist } from "../src/components/ScanChecklist";

describe("scanProgress", () => {
  it("starts on the first step with nothing done", () => {
    expect(scanProgress(0, false)).toEqual({ done: 0, active: 0 });
  });

  it("moves one step at a time", () => {
    expect(scanProgress(STEP_MS, false)).toEqual({ done: 1, active: 1 });
    expect(scanProgress(STEP_MS * 2 + 5, false)).toEqual({ done: 2, active: 2 });
  });

  it("never finishes before the response, however long the wait", () => {
    for (const ms of [STEP_MS * 10, 60_000, 10 ** 9]) {
      const p = scanProgress(ms, false);
      expect(p.done).toBe(SCAN_STEPS.length - 1);
      expect(p.active).toBe(SCAN_STEPS.length - 1);
    }
  });

  it("finishes every step once the response is in", () => {
    expect(scanProgress(0, true)).toEqual({ done: SCAN_STEPS.length, active: null });
    expect(scanProgress(STEP_MS, true)).toEqual({ done: SCAN_STEPS.length, active: null });
  });

  it("treats a bad clock as the start", () => {
    expect(scanProgress(-5, false)).toEqual({ done: 0, active: 0 });
    expect(scanProgress(Number.NaN, false)).toEqual({ done: 0, active: 0 });
  });
});

describe("a reply that never ran the checks", () => {
  it("ticks nothing for rejected or queued_for_ai", () => {
    for (const state of ["rejected", "queued_for_ai"] as const) {
      expect(scanProgress(STEP_MS * 9, true, state)).toEqual({ done: 0, active: null });
    }
  });

  it("still finishes every step for a checked result", () => {
    for (const state of ["new_cat", "matched", "needs_review"] as const) {
      expect(scanProgress(0, true, state)).toEqual({ done: SCAN_STEPS.length, active: null });
    }
  });

  it("renders no ticks and no working step", () => {
    const out = renderToStaticMarkup(createElement(ScanChecklist, { elapsedMs: 0, responded: true, state: "rejected" }));
    expect(out).not.toContain('data-done="true"');
    expect(out).not.toContain('data-active="true"');
  });

  it("says in words for a screen reader that no step was checked", () => {
    for (const state of ["rejected", "queued_for_ai"] as const) {
      const out = renderToStaticMarkup(createElement(ScanChecklist, { elapsedMs: 0, responded: true, state }));
      expect(out.match(/, not checked/g)?.length).toBe(SCAN_STEPS.length);
    }
  });

  it("does not claim steps were skipped for a checked result", () => {
    const out = renderToStaticMarkup(createElement(ScanChecklist, { elapsedMs: 0, responded: true, state: "new_cat" }));
    expect(out).not.toContain("not checked");
  });

  it("never mentions an ear-tip", () => {
    expect(SCAN_STEPS.join(" ")).not.toMatch(/ear/i);
  });
});

describe("the checklist", () => {
  const html = (elapsedMs: number, responded: boolean) =>
    renderToStaticMarkup(createElement(ScanChecklist, { elapsedMs, responded }));

  it("names the three generic steps and nothing found", () => {
    const out = html(STEP_MS * 9, false);
    for (const s of SCAN_STEPS) expect(out).toContain(s);
    expect(SCAN_STEPS).toEqual([
      "Looking for a cat",
      "Checking the coat",
      "Checking cats we know",
    ]);
    // No finding words: no coat names, no yes or no answers, no "new" or "matched" verdicts.
    expect(out).not.toMatch(/tabby|calico|tortoiseshell|tuxedo|bicolor|solid|colorpoint|none seen|\bnew\b|matched|\byes\b/i);
  });

  it("marks no step as done before the response, even after a long wait", () => {
    const out = html(STEP_MS * 99, false);
    expect(out.match(/data-done="true"/g)?.length ?? 0).toBe(SCAN_STEPS.length - 1);
    expect(out).toContain('data-active="true"');
  });

  it("marks every step done after the response", () => {
    const out = html(0, true);
    expect(out.match(/data-done="true"/g)?.length).toBe(SCAN_STEPS.length);
    expect(out).not.toContain('data-active="true"');
  });
});
