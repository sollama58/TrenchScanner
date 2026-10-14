import { describe, expect, it } from "vitest";
import { relaunchFarmReason } from "./relaunchFarm.js";

describe("relaunchFarmReason", () => {
  const at = (relaunchSiblings: number | undefined, relaunchSiblingPeakMcapUsd?: number) =>
    relaunchFarmReason({ relaunchSiblings, relaunchSiblingPeakMcapUsd });

  it("blocks a ticker launched 4 or more times in the window before it when none of them ran", () => {
    // The DOBU farm, 2026-10-14: every earlier copy dumped to the curve floor (~$3k).
    expect(at(5, 14_705)).toMatch(/ticker launched 5 other times in the 15 min before it, none past \$20k/);
    expect(at(4, 0)).not.toBeNull();
    expect(at(3, 0)).toBeNull();
  });

  it("lets through a wave where one earlier copy has run", () => {
    expect(at(8, 20_000)).toBeNull();
    expect(at(8, 150_000)).toBeNull();
  });

  it("applies only once the siblings are read", () => {
    expect(at(undefined)).toBeNull();
  });
});
