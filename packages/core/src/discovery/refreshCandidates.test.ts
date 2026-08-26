import { describe, expect, it } from "vitest";
import { DEFAULT_BAND_PADDING_RATIO, scanBand } from "./refreshCandidates.js";

describe("scanBand", () => {
  it("widens the configured band by the default padding ratio", () => {
    expect(scanBand(50_000, 500_000)).toEqual({ min: 25_000, max: 750_000 });
  });

  it("accepts a custom padding ratio", () => {
    expect(scanBand(100_000, 200_000, 0.25)).toEqual({ min: 75_000, max: 250_000 });
  });

  it("matches refreshAndFilterToBand's own default when no ratio is passed", () => {
    expect(scanBand(50_000, 500_000)).toEqual(scanBand(50_000, 500_000, DEFAULT_BAND_PADDING_RATIO));
  });

  it("a zero padding ratio leaves the band untouched", () => {
    expect(scanBand(50_000, 500_000, 0)).toEqual({ min: 50_000, max: 500_000 });
  });
});
