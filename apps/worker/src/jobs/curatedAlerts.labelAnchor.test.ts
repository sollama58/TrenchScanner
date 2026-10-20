import { describe, expect, it } from "vitest";
import { freshUnfilledAnchorPatch, labelAnchor } from "./curatedAlerts.js";

describe("label anchor on emit", () => {
  it("a later send timestamp does not become the label anchor", () => {
    const decision = new Date("2026-10-20T15:00:00.000Z");
    const sent = new Date(decision.getTime() + 90_000);
    expect(labelAnchor(decision, sent)).toEqual(decision);
    expect(labelAnchor(decision, sent).getTime()).not.toBe(sent.getTime());
    // The row update that ships with the alert does not write a new anchor.
    expect(freshUnfilledAnchorPatch()).toEqual({ extended24h: true });
    expect(Object.keys(freshUnfilledAnchorPatch())).not.toContain("anchorAt");
  });
});
