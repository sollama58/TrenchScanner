import { describe, expect, it } from "vitest";
import { isCurveVenue, launchpadFromVenue, normalizeLaunchpad } from "./launchpads.js";

describe("normalizeLaunchpad", () => {
  it("gives every source's spelling one name, and keeps a launchpad nobody has mapped", () => {
    expect(normalizeLaunchpad("pump.fun")).toBe("pumpfun");
    expect(normalizeLaunchpad("pump")).toBe("pumpfun");
    expect(normalizeLaunchpad("pump-fun")).toBe("pumpfun");
    expect(normalizeLaunchpad("stonkfun")).toBe("stonks");
    expect(normalizeLaunchpad(" Stonk.Fun ")).toBe("stonks");
    expect(normalizeLaunchpad("Bonk")).toBe("bonk");
    expect(normalizeLaunchpad("x".repeat(60))).toHaveLength(40);
    expect(normalizeLaunchpad("")).toBeUndefined();
    expect(normalizeLaunchpad(7)).toBeUndefined();
  });
});

describe("venues", () => {
  it("knows both launchpads' curves, and which launchpad a venue gives away", () => {
    expect(isCurveVenue("pumpfun")).toBe(true);
    expect(isCurveVenue("stonkfun")).toBe(true);
    expect(isCurveVenue("raydium")).toBe(false);
    expect(isCurveVenue(undefined)).toBe(false);
    expect(launchpadFromVenue("pumpswap")).toBe("pumpfun");
    expect(launchpadFromVenue("stonkfun")).toBe("stonks");
    expect(launchpadFromVenue("raydium")).toBeUndefined();
  });
});
