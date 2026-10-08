import { describe, expect, it } from "vitest";
import { buildCandidateFeatures, CANDIDATE_FEATURE_NAMES, TRADE_FLOW_FEATURES } from "./features.js";
import { EMPTY_TRADE_FLOW, resolveDevHolding, TradeFlowBook, type FlowTrade } from "./tradeFlow.js";
import type { ScoredToken } from "../types.js";

const MINT = "mintA";
const T0 = 1_000_000_000_000;
const sec = (s: number) => T0 + s * 1000;

function trade(
  wallet: string,
  side: "buy" | "sell",
  sol: number,
  at: number,
  extra: Partial<FlowTrade> = {},
): FlowTrade {
  return { mint: MINT, wallet, side, sol, tokenAmount: sol * 1_000_000, at, ...extra };
}

describe("TradeFlowBook", () => {
  it("summarizes the last 5 minutes of a launch it saw: buyers, sizes, whales, fresh demand, net flow", () => {
    const book = new TradeFlowBook();
    book.launch({
      mint: MINT,
      creator: "dev",
      initialBuyTokens: 50_000_000,
      initialBuySol: 1.5,
      marketCapSol: 30,
      at: T0,
    });
    book.trade(trade("a", "buy", 1, sec(60), { marketCapSol: 40 }));
    book.trade(trade("a", "buy", 1, sec(70)));
    book.trade(trade("b", "buy", 2, sec(80)));
    book.trade(trade("c", "sell", 1, sec(90), { marketCapSol: 40 }));
    const f = book.features(MINT, sec(120));
    expect(f.uniqueBuyers5m).toBe(2);
    expect(f.buysPerBuyer5m).toBe(1.5);
    expect(f.avgBuySol5m).toBeCloseTo(4 / 3);
    expect(f.topBuyerShare5m).toBe(0.5);
    expect(f.newBuyerShare5m).toBe(1);
    expect(f.netFlow5mToMcap).toBeCloseTo(3 / 40);
    expect(f.tradesPerMin5m).toBe(2); // 4 trades over the 2 minutes it has existed
    expect(f.devInitialBuySol).toBe(1.5);
  });

  it("reads a busy mint's trade rate off the span its window buffer still holds", () => {
    // 10 trades a second for 5 minutes: 3,000 trades, more than the buffer keeps.
    const book = new TradeFlowBook();
    book.launch({ mint: MINT, creator: "dev", marketCapSol: 30, at: T0 });
    for (let i = 0; i < 3_000; i += 1) book.trade(trade(`w${i % 50}`, "buy", 0.1, T0 + i * 100));
    const f = book.features(MINT, T0 + 300_000);
    expect(f.tradesPerMin5m).toBeCloseTo(600, -1);
  });

  it("keeps the dev's sells when a create message arrives twice", () => {
    const book = new TradeFlowBook();
    const create = { mint: MINT, creator: "dev", initialBuyTokens: 100, initialBuySol: 1, at: T0 };
    book.launch(create);
    book.trade(trade("dev", "sell", 1, sec(10), { tokenAmount: 100 }));
    book.launch(create);
    expect(book.features(MINT, sec(20)).devSoldShare).toBe(1);
  });

  it("tracks the launch's early buyers and the dev's bag", () => {
    const book = new TradeFlowBook();
    book.launch({ mint: MINT, creator: "dev", initialBuyTokens: 50_000_000, at: T0 });
    // Two snipers inside 30s, one regular buyer after.
    book.trade(trade("s1", "buy", 1, sec(1), { tokenAmount: 30_000_000, newTokenBalance: 30_000_000 }));
    book.trade(trade("s2", "buy", 1, sec(2), { tokenAmount: 20_000_000, newTokenBalance: 20_000_000 }));
    book.trade(trade("late", "buy", 1, sec(45), { tokenAmount: 10_000_000 }));
    // s1 dumps half, the dev dumps everything.
    book.trade(trade("s1", "sell", 0.5, sec(100), { tokenAmount: 15_000_000, newTokenBalance: 15_000_000 }));
    book.trade(trade("dev", "sell", 2, sec(110), { tokenAmount: 50_000_000, newTokenBalance: 0 }));
    const f = book.features(MINT, sec(120));
    expect(f.earlyBuyerCount).toBe(2);
    expect(f.earlyBuyerHoldPct).toBeCloseTo(3.5); // 35M of 1B
    expect(f.earlyBuyerSoldShare).toBeCloseTo(15 / 50);
    expect(f.devSoldShare).toBe(1);
  });

  it("counts how many of the first 25 buyers after launch still hold, dust and dev aside", () => {
    const book = new TradeFlowBook();
    book.launch({ mint: MINT, creator: "dev", initialBuyTokens: 50_000_000, at: T0 });
    book.trade(trade("dev", "buy", 1, sec(1), { tokenAmount: 1_000_000 }));
    for (let i = 0; i < 30; i++) {
      book.trade(
        trade(`w${i}`, "buy", 1, sec(2 + i), { tokenAmount: 1_000_000, newTokenBalance: 1_000_000 }),
      );
    }
    let f = book.features(MINT, sec(60));
    expect(f.firstBuyersSeen).toBe(25);
    expect(f.firstBuyersHolding).toBe(25);
    // w0 sells out, w1 leaves dust, w2 sells half, w29 (not a first buyer) sells out.
    book.trade(trade("w0", "sell", 1, sec(70), { tokenAmount: 1_000_000, newTokenBalance: 0 }));
    book.trade(trade("w1", "sell", 1, sec(71), { tokenAmount: 995_000, newTokenBalance: 5_000 }));
    book.trade(trade("w2", "sell", 0.5, sec(72), { tokenAmount: 500_000, newTokenBalance: 500_000 }));
    book.trade(trade("w29", "sell", 1, sec(73), { tokenAmount: 1_000_000, newTokenBalance: 0 }));
    f = book.features(MINT, sec(80));
    expect(f.firstBuyersHolding).toBe(23);
    expect(f.firstBuyersSeen).toBe(25);
    const features = buildCandidateFeatures({
      mintAddress: MINT,
      priceUsd: 1,
      marketCapUsd: 100_000,
      narrativeTags: [],
      rugScreen: { passed: true, reasons: [] },
      score: { momentum: 0, holderHealth: 0, age: 0, narrative: 0, total: 0 },
      tradeFlow: f,
    } as ScoredToken);
    expect(features.firstBuyersHolding).toBe(23);
    expect("firstBuyersSeen" in features).toBe(false);
  });

  it("only counts first buyers on a launch it saw", () => {
    const book = new TradeFlowBook();
    book.watch([MINT], T0);
    book.trade(trade("a", "buy", 1, sec(10)));
    expect(book.features(MINT, sec(20)).firstBuyersHolding).toBeNull();
  });

  it("says nothing it didn't watch: no launch seen, and under 5 minutes of watching", () => {
    const book = new TradeFlowBook();
    book.watch([MINT], T0);
    book.trade(trade("a", "buy", 1, sec(10)));
    const early = book.features(MINT, sec(60));
    expect(early.uniqueBuyers5m).toBeNull();
    expect(early.earlyBuyerCount).toBeNull();
    expect(early.devSoldShare).toBeNull();
    const later = book.features(MINT, sec(6 * 60));
    expect(later.uniqueBuyers5m).toBe(0); // watched the whole window, and the one buy aged out
    expect(later.earlyBuyerCount).toBeNull();
    expect(book.features("unknown", sec(0)).uniqueBuyers5m).toBeNull();
  });

  it("drops idle mints and launches that never took off, but keeps what the scan watches", () => {
    const book = new TradeFlowBook({ idleMs: 15 * 60_000, launchGraceMs: 10 * 60_000, minMcapSol: 45 });
    book.launch({ mint: "dud", marketCapSol: 30, at: T0 });
    book.launch({ mint: "runner", marketCapSol: 30, at: T0 });
    book.trade({ mint: "runner", wallet: "x", side: "buy", sol: 5, marketCapSol: 120, at: sec(500) });
    book.watch(["kept"], sec(600));
    expect(book.evict(sec(11 * 60)).sort()).toEqual(["dud"]);
    expect(book.has("runner")).toBe(true);
    expect(book.evict(sec(26 * 60)).sort()).toEqual(["kept", "runner"]);
  });

  it("caps the number of mints, dropping the least recently traded", () => {
    const book = new TradeFlowBook({ maxMints: 2 });
    for (const [i, m] of ["m1", "m2", "m3"].entries()) {
      book.launch({ mint: m, marketCapSol: 100, at: T0 });
      book.trade({ mint: m, wallet: "w", side: "buy", sol: 1, marketCapSol: 100, at: sec(i) });
    }
    expect(book.evict(sec(10))).toEqual(["m1"]);
    expect(book.size).toBe(2);
  });
});

describe("order-flow features in the vector", () => {
  it("are appended after every older feature and read from the token's tradeFlow", () => {
    const names = CANDIDATE_FEATURE_NAMES as readonly string[];
    // After every feature that predates them; only the later text, path, market, 5m-flow and
    // narrative inputs (and the narrative part of the score they feed), the livestream and the
    // pair's age follow.
    const start = names.indexOf(TRADE_FLOW_FEATURES[0]);
    expect(names.slice(start, start + TRADE_FLOW_FEATURES.length)).toEqual([...TRADE_FLOW_FEATURES]);
    expect(
      names
        .slice(start + TRADE_FLOW_FEATURES.length)
        .every((n) =>
          /^(text|path|mkt|ctx|buys5m|sells5m|buyRatio5m|ns[A-Z]|scoreNarrativeV2$|livestream|pairAgeMinutes$)/.test(
            n,
          ),
        ),
    ).toBe(true);
    const scored = {
      mintAddress: MINT,
      priceUsd: 1,
      marketCapUsd: 100_000,
      narrativeTags: [],
      rugScreen: { passed: true, reasons: [] },
      score: { momentum: 0, holderHealth: 0, age: 0, narrative: 0, total: 0 },
    } as ScoredToken;
    expect(buildCandidateFeatures(scored).uniqueBuyers5m).toBeNull();
    const book = new TradeFlowBook();
    book.launch({ mint: MINT, creator: "dev", initialBuySol: 2, at: T0 });
    scored.tradeFlow = book.features(MINT, sec(30));
    expect(buildCandidateFeatures(scored).devInitialBuySol).toBe(2);
  });
});

describe("resolveDevHolding", () => {
  it("prefers the trade stream's view of the dev's bag, then RugCheck's creator balance", () => {
    const flow = (devSoldShare: number | null) => ({ ...EMPTY_TRADE_FLOW, devSoldShare });
    expect(resolveDevHolding({ tradeFlow: flow(1), creatorHolding: true })).toBe(false);
    expect(resolveDevHolding({ tradeFlow: flow(0.5), creatorHolding: false })).toBe(true);
    expect(resolveDevHolding({ tradeFlow: flow(null), creatorHolding: false })).toBe(false);
    expect(resolveDevHolding({ tradeFlow: flow(null) })).toBeNull();
    expect(resolveDevHolding({})).toBeNull();
  });
});
