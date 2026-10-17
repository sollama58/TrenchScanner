import { describe, expect, it } from "vitest";
import { afterText, entryText, type HolderEntry } from "./holderEntry";

const entry = (e: Partial<HolderEntry>): HolderEntry => ({
  firstBuyAt: 1_000,
  afterLaunchS: 4,
  firstBuyerRank: null,
  buys: 1,
  sells: 0,
  solIn: 2.1,
  solOut: 0,
  soldShare: 0,
  ...e,
});

describe("entryText", () => {
  it("says when it bought, its rank, the SOL in and that it holds all", () => {
    expect(entryText(entry({ firstBuyerRank: 3 }))).toBe(
      "Bought 4s after launch (#3 buyer) · 2.1 SOL · holding all",
    );
  });
  it("says how much it sold and for what", () => {
    expect(entryText(entry({ afterLaunchS: 200, sells: 2, solOut: 1.84, soldShare: 0.4 }))).toBe(
      "Bought 3m after launch · 2.1 SOL · sold 40% for 1.8 SOL",
    );
    expect(entryText(entry({ sells: 1, solOut: 12, soldShare: 1 }))).toBe(
      "Bought 4s after launch · 2.1 SOL · sold all for 12 SOL",
    );
  });
  it("leaves the time out when the tape didn't read the launch", () => {
    expect(entryText(entry({ afterLaunchS: null, solIn: 0.25 }))).toBe("Bought · 0.25 SOL · holding all");
  });
  it("names a holder that never bought", () => {
    expect(entryText(entry({ buys: 0, firstBuyAt: null, afterLaunchS: null, soldShare: null }))).toBe(
      "Got it by transfer, never bought",
    );
  });
});

describe("afterText", () => {
  it("reads seconds, minutes, hours and days", () => {
    expect([afterText(59), afterText(90), afterText(3_900), afterText(40_000), afterText(200_000)]).toEqual([
      "59s",
      "2m",
      "1h 5m",
      "11h",
      "2d",
    ]);
  });
});
