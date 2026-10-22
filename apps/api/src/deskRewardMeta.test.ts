import { describe, expect, it } from "vitest";
import { enrichCreatorFeeDeskRewards, enrichDeskRewards } from "./deskRewardMeta.js";

const MINT = "So11111111111111111111111111111111111111112";

describe("enrichDeskRewards", () => {
  it("returns null for an empty list", async () => {
    expect(await enrichDeskRewards(null)).toBeNull();
    expect(await enrichDeskRewards([])).toBeNull();
  });

  it("passes rewards through unchanged in shape", async () => {
    const rewards = [{ label: "NVDAx", mint: null }];
    const out = await enrichDeskRewards(rewards);
    expect(out).toEqual(rewards);
  });
});

describe("enrichCreatorFeeDeskRewards", () => {
  it("does nothing when no desk rewards are present", async () => {
    const fees = new Map([["mint", { deskRewards: null }]]);
    await enrichCreatorFeeDeskRewards(fees);
    expect(fees.get("mint")?.deskRewards).toBeNull();
  });
});
