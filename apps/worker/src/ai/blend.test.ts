import { describe, expect, it } from "vitest";
import { AI_BLEND_KIND } from "@trenchscanner/core";
import { blendRowsFor, blendUsableFor, type StoredAiBlendParams } from "./blend.js";

const review = (tokenId: string, playbookId: string | null, labelValue: number, ai: number | null = 0.4) => ({
  tokenId,
  playbookId,
  curatorProbability: 0.3,
  probability2x: ai,
  candidateOutcome: { labelValue },
});

describe("blendRowsFor", () => {
  it("fits on the active playbook's reviews, one per token, the first", () => {
    const rows = blendRowsFor(
      [
        review("a", "pb2", 1),
        review("a", "pb2", 0), // a's second review: the same coin again
        review("b", "pb1", 1), // another playbook's record
        review("c", "pb2", 0),
        review("d", null, 1),
      ],
      "pb2",
    );
    expect(rows).toEqual([
      { curatorProbability: 0.3, aiProbability: 0.4, labelValue: 1 },
      { curatorProbability: 0.3, aiProbability: 0.4, labelValue: 0 },
    ]);
  });

  it("drops a token whose first review had no odds, rather than using a later one", () => {
    expect(blendRowsFor([review("a", "pb", 0, null), review("a", "pb", 1)], "pb")).toEqual([]);
  });
});

describe("blendUsableFor", () => {
  const params: StoredAiBlendParams = {
    kind: AI_BLEND_KIND,
    intercept: 0,
    wCurator: 1,
    wAi: 1,
    cutoff: 0.3,
    usable: true,
  };

  it("gates only under the playbook it was fitted on", () => {
    expect(blendUsableFor({ ...params, playbookId: "pb2" }, "pb2")).toBe(true);
    expect(blendUsableFor({ ...params, playbookId: "pb1" }, "pb2")).toBe(false);
    // Stored before the playbook was recorded: no evidence it belongs to this one.
    expect(blendUsableFor(params, "pb2")).toBe(false);
  });

  it("needs a usable fit with a cutoff", () => {
    expect(blendUsableFor({ ...params, usable: false, playbookId: "pb" }, "pb")).toBe(false);
    expect(blendUsableFor({ ...params, cutoff: null, playbookId: "pb" }, "pb")).toBe(false);
    expect(blendUsableFor(null, "pb")).toBe(false);
  });
});
