import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StaffLocation } from "../src/components/StaffLocation";
import { mapLink } from "../src/lib/mapLink";

describe("mapLink", () => {
  it("gives directions to an exact spot", () => {
    expect(mapLink({ exact: { lat: 1.30412, lng: 103.85 + 0.00123, approximate: false }, area: "Tiong Bahru", exactHidden: false })).toEqual({
      href: "https://www.google.com/maps/dir/?api=1&destination=1.30412%2C103.85123",
      label: "Get directions",
    });
  });
  it("only shows an approximate spot on the map, never directions to a midpoint", () => {
    const link = mapLink({ exact: { lat: 1.3, lng: 103.8, approximate: true }, area: "Tiong Bahru", exactHidden: false });
    expect(link).toEqual({ href: "https://www.google.com/maps/search/?api=1&query=1.3%2C103.8", label: "See on map" });
    expect(link?.href).not.toContain("/dir/");
  });
  it("searches the area name when the exact spot is hidden, with no coordinates", () => {
    const link = mapLink({ exact: null, area: "Tiong Bahru & Strand", exactHidden: true });
    expect(link).toEqual({ href: "https://www.google.com/maps/search/?api=1&query=Tiong%20Bahru%20%26%20Strand", label: "See area on map" });
    expect(link?.href).not.toMatch(/\d+\.\d+/);
  });
  it("gives no link without a location", () => {
    expect(mapLink({ exact: null, area: "Tiong Bahru", exactHidden: false })).toBeNull();
  });
});

describe("StaffLocation", () => {
  const html = (p: { exact: { lat: number; lng: number; approximate: boolean } | null; exactHidden: boolean }) =>
    renderToStaticMarkup(createElement(StaffLocation, { area: "Tiong Bahru", ...p }));
  it("opens the link in a new tab safely and keeps the coordinates as text", () => {
    const out = html({ exact: { lat: 1.30412, lng: 103.85123, approximate: false }, exactHidden: false });
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain("1.30412, 103.85123");
    expect(out).toContain("Get directions");
  });
  it("holds no coordinates at all in a demo render, including the link", () => {
    const out = html({ exact: null, exactHidden: true });
    expect(out).toContain("See area on map");
    // One compact line: the area and a small "Map" link, no repeated disclaimer.
    expect(out).toContain(">Map<");
    expect(out).not.toContain("Exact spots are hidden");
    expect(out).toContain("Tiong%20Bahru");
    expect(out).not.toMatch(/-?\d+\.\d{3,}/);
    expect(out).not.toContain("%2C");
  });
  it("keeps the old message when nothing is on file", () => {
    const out = html({ exact: null, exactHidden: false });
    expect(out).toContain("No location on file.");
    expect(out).not.toContain("<a");
  });
});
