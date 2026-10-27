// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { describe, expect, it } from "vitest";
import { EMPTY_TRADE_FLOW } from "@trenchscanner/core";
import { withTapeWindow } from "./scanJob.js";

describe("withTapeWindow (model audit 2026-10-26, §16)", () => {
  const tape = { ...EMPTY_TRADE_FLOW, uniqueBuyers5m: 12, tradesPerMin5m: 3, netFlow5mToMcap: 0.02 };

  it("fills the 5m fields off the tape when the stream has no window of its own (its free tier)", () => {
    // The free stream carries the dev's launch buy and nothing else.
    const stream = { ...EMPTY_TRADE_FLOW, devInitialBuySol: 1.5, firstBuyersHolding: 7 };
    expect(withTapeWindow(stream, tape, false)).toMatchObject({
      uniqueBuyers5m: 12,
      tradesPerMin5m: 3,
      netFlow5mToMcap: 0.02,
      devInitialBuySol: 1.5,
      firstBuyersHolding: 7,
    });
    expect(withTapeWindow(undefined, tape, false)).toMatchObject({
      uniqueBuyers5m: 12,
      devInitialBuySol: null,
    });
  });

  it("keeps a stream window that was watched, even a quiet one, over a tape read", () => {
    const watched = { ...EMPTY_TRADE_FLOW, uniqueBuyers5m: 0, tradesPerMin5m: 0 };
    expect(withTapeWindow(watched, tape, false)).toBe(watched);
  });

  it("leaves the fields unknown, never 0, when neither source has trades", () => {
    const stream = { ...EMPTY_TRADE_FLOW, devInitialBuySol: 1.5 };
    expect(withTapeWindow(stream, null, false)).toBe(stream);
    expect(withTapeWindow(undefined, null, false)).toBeUndefined();
    // An incomplete empty page reads as unknown too.
    const unknown = { ...EMPTY_TRADE_FLOW };
    expect(withTapeWindow(stream, unknown, false)).toMatchObject({
      uniqueBuyers5m: null,
      devInitialBuySol: 1.5,
    });
  });

  it("reads a coin the stream never carries (Stonks) from the tape alone", () => {
    // The book, asked about a coin it never sees trades for, would read a quiet window.
    const quiet = { ...EMPTY_TRADE_FLOW, uniqueBuyers5m: 0, tradesPerMin5m: 0, firstBuyersHolding: 2 };
    expect(withTapeWindow(quiet, tape, true)).toMatchObject({ uniqueBuyers5m: 12, firstBuyersHolding: 2 });
    expect(withTapeWindow(quiet, null, true)).toMatchObject({
      uniqueBuyers5m: null,
      tradesPerMin5m: null,
      firstBuyersHolding: 2,
    });
  });
});
