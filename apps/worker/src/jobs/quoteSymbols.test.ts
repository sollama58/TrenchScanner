import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CandidateToken } from "@trenchscanner/core";
import { quoteSymbolsFor, resetQuoteSymbolState, resolveQuoteSymbols } from "./quoteSymbols.js";

const USD1 = "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB";
const TRACKED = "TrackedLaunch1111111111111111111111111pump";
const STOCK = "StockToken11111111111111111111111111111111";
const BARE = "NoMetadata111111111111111111111111111111111";

const db = (rows: { mintAddress: string; symbol: string | null }[]) => ({
  token: { findMany: vi.fn(async () => rows) },
});
const helius = (answer: Map<string, { symbol: string | null; name: string | null }> | "failed") => ({
  getTokenSymbolsBatch: vi.fn(async () => answer),
});
const candidate = (quoteMint?: string, quoteSymbol?: string) =>
  ({ mintAddress: "coin", priceUsd: 1, marketCapUsd: 1, quoteMint, quoteSymbol }) as CandidateToken;

beforeEach(() => resetQuoteSymbolState());

describe("quoteSymbolsFor", () => {
  it("names quotes from the usual list, the Token table, then token metadata", async () => {
    const reader = helius(
      new Map([
        [STOCK, { symbol: "SPCX", name: "SpaceX" }],
        [BARE, { symbol: null, name: null }],
      ]),
    );
    const out = await quoteSymbolsFor(
      [USD1, TRACKED, STOCK, BARE],
      reader,
      db([{ mintAddress: TRACKED, symbol: "$ASDF" }]),
    );
    expect(Object.fromEntries(out)).toEqual({ [USD1]: "USD1", [TRACKED]: "ASDF", [STOCK]: "SPCX" });
    expect(reader.getTokenSymbolsBatch).toHaveBeenCalledWith([STOCK, BARE]);

    // Remembered: no second lookup, and a mint naming nothing isn't asked again.
    const again = helius(new Map());
    await quoteSymbolsFor([STOCK, BARE], again, db([]));
    expect(again.getTokenSymbolsBatch).not.toHaveBeenCalled();
  });

  it("never takes an address for a ticker, and backs off a failed lookup", async () => {
    const reader = helius(new Map([[STOCK, { symbol: STOCK, name: "Space stock" }]]));
    expect((await quoteSymbolsFor([STOCK], reader, db([]))).get(STOCK)).toBe("Space stock");

    resetQuoteSymbolState();
    const failing = helius("failed");
    expect((await quoteSymbolsFor([STOCK], failing, db([]), 0)).size).toBe(0);
    await quoteSymbolsFor([STOCK], failing, db([]), 1_000);
    expect(failing.getTokenSymbolsBatch).toHaveBeenCalledTimes(1);
  });
});

describe("resolveQuoteSymbols", () => {
  it("fills in missing tickers and drops a quote it can't name, so no bare mint is stored", async () => {
    const named = candidate(STOCK);
    const unnamed = candidate(BARE);
    const own = candidate(TRACKED, "$ASDF");
    const sol = candidate();
    await resolveQuoteSymbols(
      [named, unnamed, own, sol],
      helius(new Map([[STOCK, { symbol: "SPCX", name: null }]])),
      db([]),
    );
    expect(named.quoteSymbol).toBe("SPCX");
    expect(unnamed.quoteMint).toBeUndefined();
    expect(own.quoteSymbol).toBe("ASDF");
    expect(sol.quoteMint).toBeUndefined();
  });
});
