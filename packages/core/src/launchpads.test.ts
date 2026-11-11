import { describe, expect, it } from "vitest";
import {
  bestLaunchpad,
  isCurveVenue,
  isLaunchHomeCurve,
  isLaunchLabLaunchpad,
  launchLabCurveVenue,
  launchpadFromVenue,
  launchpadOfLaunchLabPlatform,
  normalizeLaunchpad,
  resolveLaunchpad,
  SCANNED_LAUNCHPADS,
} from "./launchpads.js";

describe("normalizeLaunchpad", () => {
  it("gives every source's spelling one name, and keeps a launchpad nobody has mapped", () => {
    expect(normalizeLaunchpad("pump.fun")).toBe("pumpfun");
    expect(normalizeLaunchpad("pump")).toBe("pumpfun");
    expect(normalizeLaunchpad("pump-fun")).toBe("pumpfun");
    expect(normalizeLaunchpad("stonkfun")).toBe("stonks");
    expect(normalizeLaunchpad(" Stonk.Fun ")).toBe("stonks");
    expect(normalizeLaunchpad("Bonk")).toBe("bonk");
    expect(normalizeLaunchpad("letsbonk.fun")).toBe("bonk");
    expect(normalizeLaunchpad("raydium-launchlab")).toBe("launchlab");
    expect(normalizeLaunchpad("met-dbc")).toBe("met-dbc");
    // Nothing off the object's prototype is a spelling.
    expect(normalizeLaunchpad("constructor")).toBe("constructor");
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
    expect(isCurveVenue("meteoradbc")).toBe(false);
    expect(isCurveVenue("launchlab")).toBe(true);
    expect(isCurveVenue(undefined)).toBe(false);
    expect(isLaunchHomeCurve("pumpfun")).toBe(true);
    expect(isLaunchHomeCurve("meteoradbc")).toBe(true);
    expect(isLaunchHomeCurve("launchlab")).toBe(true);
    expect(isLaunchHomeCurve("meteora")).toBe(false);
    expect(launchpadFromVenue("pumpswap")).toBe("pumpfun");
    expect(launchpadFromVenue("stonkfun")).toBe("stonks");
    expect(launchpadFromVenue("launchlab")).toBe("launchlab");
    expect(launchpadFromVenue("raydium")).toBeUndefined();
    expect(launchLabCurveVenue("stonks")).toBe("stonkfun");
    expect(launchLabCurveVenue("float")).toBe("launchlab");
    expect(launchLabCurveVenue("pumpfun")).toBeUndefined();
  });
});

describe("LaunchLab launchpads", () => {
  it("scans Pump.fun and every LaunchLab launchpad, and nothing else", () => {
    for (const pad of ["pumpfun", "stonks", "float", "bonk", "launchlab"])
      expect(SCANNED_LAUNCHPADS.has(pad)).toBe(true);
    expect(SCANNED_LAUNCHPADS.has("met-dbc")).toBe(false);
    expect(isLaunchLabLaunchpad("float")).toBe(true);
    expect(isLaunchLabLaunchpad("pumpfun")).toBe(false);
    expect(isLaunchLabLaunchpad(null)).toBe(false);
  });

  it("names a LaunchLab coin's launchpad by its platform config, never by a config's own name", () => {
    expect(launchpadOfLaunchLabPlatform("2TDPJJPV6nvTEqXABxrqno6Uzpipxxvh1zjLN3SMYn69")).toBe("float");
    expect(launchpadOfLaunchLabPlatform("6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt")).toBe("stonks");
    expect(launchpadOfLaunchLabPlatform("FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1")).toBe("bonk");
    // A config someone named "Float" (9Chm…, two pools) is not Float's.
    expect(launchpadOfLaunchLabPlatform("9ChmjpSuwTsCw77ZKV2g9oSADLkeUzRunSCMVCDCWpP")).toBe("launchlab");
    expect(launchpadOfLaunchLabPlatform("toString")).toBe("launchlab");
    expect(launchpadOfLaunchLabPlatform(undefined)).toBe("launchlab");
    expect(resolveLaunchpad("raydium-launchlab", "2TDPJJPV6nvTEqXABxrqno6Uzpipxxvh1zjLN3SMYn69")).toBe(
      "float",
    );
    expect(resolveLaunchpad("raydium-launchlab", null)).toBe("launchlab");
    // A launchpad the source names itself stands, whatever the config.
    expect(resolveLaunchpad("stonkfun", "2TDPJJPV6nvTEqXABxrqno6Uzpipxxvh1zjLN3SMYn69")).toBe("stonks");
    expect(resolveLaunchpad("pump.fun", undefined)).toBe("pumpfun");
    expect(resolveLaunchpad(undefined, "2TDPJJPV6nvTEqXABxrqno6Uzpipxxvh1zjLN3SMYn69")).toBeUndefined();
  });

  it("keeps a recorded launchpad, except a generic LaunchLab a platform's name replaces", () => {
    expect(bestLaunchpad("stonks", "float", undefined)).toBe("stonks");
    expect(bestLaunchpad("launchlab", "float", "launchlab")).toBe("float");
    expect(bestLaunchpad("raydium-launchlab", undefined, "launchlab")).toBe("launchlab");
    expect(bestLaunchpad("launchlab", "pumpfun", undefined)).toBe("launchlab");
    expect(bestLaunchpad(null, undefined, "pumpfun")).toBe("pumpfun");
    expect(bestLaunchpad(null, undefined, undefined)).toBeUndefined();
  });
});
