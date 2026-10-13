import { beforeEach, describe, expect, it } from "vitest";
import { settledMayhem } from "./mayhemMode.js";
import { knownPreBondSeconds, rememberLaunchTimes, resetLaunchTimes } from "./launchTimes.js";
import { settledRejects } from "./settledRejects.js";

const GRAD = new Date(1_791_674_763_000);
const env = { SAFETY_MIN_PREBOND_SECONDS: 5 };

describe("settledRejects", () => {
  beforeEach(() => {
    resetLaunchTimes();
    // Every mint below is answered from memory, so no test here reaches the database.
    for (const [mint, mayhem] of [
      ["mayhem", true],
      ["plain", false],
      ["instant", false],
      ["slow", false],
      ["viewed", true],
    ] as const) {
      settledMayhem.remember(mint, mayhem);
    }
  });

  it("names Mayhem coins and coins bonded under the floor, from what is already known", async () => {
    rememberLaunchTimes([
      { mintAddress: "instant", createdAt: new Date(GRAD.getTime() - 2_000) },
      { mintAddress: "slow", createdAt: new Date(GRAD.getTime() - 60_000) },
    ]);
    const out = await settledRejects(
      [
        { mintAddress: "mayhem" },
        { mintAddress: "plain" },
        { mintAddress: "instant", graduatedAt: GRAD },
        { mintAddress: "slow", graduatedAt: GRAD },
      ],
      env,
    );
    expect([...out].sort()).toEqual(["instant", "mayhem"]);
  });

  it("leaves out a coin someone has open, and every pre-bond verdict when the cut is off", async () => {
    rememberLaunchTimes([{ mintAddress: "instant", createdAt: new Date(GRAD.getTime() - 2_000) }]);
    const out = await settledRejects(
      [{ mintAddress: "viewed" }, { mintAddress: "instant", graduatedAt: GRAD }],
      { SAFETY_MIN_PREBOND_SECONDS: 0 },
      new Set(["viewed"]),
    );
    expect(out.size).toBe(0);
  });

  it("knows no pre-bond time for a coin whose launch was never seen", () => {
    expect(knownPreBondSeconds([{ mintAddress: "unseen", graduatedAt: GRAD }]).size).toBe(0);
  });
});
