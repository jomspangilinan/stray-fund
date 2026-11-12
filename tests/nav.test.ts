import { describe, expect, it } from "vitest";
import { DESK_TABS, deskSwitchFor, isActiveTab, isOnDesk, TABS, tabsFor } from "../src/lib/nav";

describe("desk navigation", () => {
  it("shows the desk tabs on every desk page and never the neighbour tabs there", () => {
    for (const p of ["/caretaker", "/caretaker/cats", "/caretaker/rules"]) expect(tabsFor(p)).toBe(DESK_TABS);
  });

  it("shows the neighbour tabs everywhere else", () => {
    for (const p of ["/", "/spot", "/cats/12", "/vet", "/caretakers", "/caretaker-x"]) expect(tabsFor(p)).toBe(TABS);
  });

  it("gives anyone on the desk a way out, and only a caretaker a way back", () => {
    for (const r of [null, undefined, "donor", "vet", "foster", "caretaker"] as const) {
      expect(deskSwitchFor(r, "/caretaker")).toEqual({ href: "/", label: "Neighbour view" });
    }
    for (const r of [null, undefined, "donor", "vet", "foster"] as const) {
      expect(deskSwitchFor(r, "/")).toBeNull();
      expect(deskSwitchFor(r, "/vet")).toBeNull();
    }
  });

  it("names the three desk tabs in order", () => {
    expect(DESK_TABS.map((t) => [t.label, t.href])).toEqual([
      ["To check", "/caretaker"],
      ["Cats", "/caretaker/cats"],
      ["Rules", "/caretaker/rules"],
    ]);
  });

  it("lights one desk tab per page", () => {
    const [check, cats, rules] = DESK_TABS;
    expect(isActiveTab(check, "/caretaker")).toBe(true);
    expect(isActiveTab(check, "/caretaker/cats")).toBe(false);
    expect(isActiveTab(check, "/caretaker/rules")).toBe(false);
    expect(isActiveTab(cats, "/caretaker/cats")).toBe(true);
    expect(isActiveTab(rules, "/caretaker/rules")).toBe(true);
  });

  it("flips the header link between the desk and the neighbour view", () => {
    expect(deskSwitchFor("caretaker", "/caretaker/rules")).toEqual({ href: "/", label: "Neighbour view" });
    expect(deskSwitchFor("caretaker", "/")).toEqual({ href: "/caretaker", label: "Back to desk" });
    expect(deskSwitchFor("caretaker", "/cats/12")).toEqual({ href: "/caretaker", label: "Back to desk" });
  });

  it("counts only /caretaker and the pages under it as the desk", () => {
    expect(isOnDesk("/caretaker")).toBe(true);
    expect(isOnDesk("/caretaker/cats")).toBe(true);
    expect(isOnDesk("/caretakers")).toBe(false);
    expect(isOnDesk("/caretaker-x")).toBe(false);
    expect(isOnDesk("/vet")).toBe(false);
  });
});
