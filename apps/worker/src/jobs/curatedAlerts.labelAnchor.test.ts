import { describe, expect, it } from "vitest";
import { freshUnfilledAnchorPatch } from "./curatedAlerts.js";

describe("label anchor on emit", () => {
  it("the row update that ships with the alert does not write a new anchor", () => {
    expect(freshUnfilledAnchorPatch()).toEqual({ extended24h: true });
    expect(Object.keys(freshUnfilledAnchorPatch())).not.toContain("anchorAt");
  });
});
