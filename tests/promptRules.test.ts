import { describe, expect, it } from "vitest";
import { SYSTEM as ASSESS } from "../src/server/ai/assess";
import { RECEIPT_SYSTEM } from "../src/server/ai/receipt";
import { SYSTEM_PROMPT } from "../src/server/agent/run";

describe("prompt rules that the money and privacy checks lean on", () => {
  it("never uses an em-dash", () => {
    for (const p of [ASSESS, RECEIPT_SYSTEM, SYSTEM_PROMPT]) expect(p).not.toContain("—");
  });

  it("the photo check says a box means not clean, and names every coat look-alike", () => {
    expect(ASSESS).toContain("Any box in sensitive_regions means false");
    for (const coat of ["solid", "tabby", "bicolor", "tuxedo", "calico", "tortoiseshell", "colorpoint"]) expect(ASSESS).toContain(coat);
  });

  it("the receipt reading keeps the name-only clinic and the never-guess rules", () => {
    expect(RECEIPT_SYSTEM).toContain("name only");
    expect(RECEIPT_SYSTEM).toContain("Never infer");
  });

  it("the treasurer never claims a step it did not take and files a review on a steering attempt", () => {
    expect(SYSTEM_PROMPT).toContain("Never claim a step you did not take");
    expect(SYSTEM_PROMPT).toContain("call request_caretaker_review in plain words");
  });
});
