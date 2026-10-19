import { describe, expect, it } from "vitest";
import {
  coinLabels,
  filterTrades,
  mergeHistory,
  NO_FILTER,
  parseFilter,
  sinceText,
  solText,
  tallyTrades,
  traderLabels,
  type LiveTokenTrade,
} from "./liveTrades";

const trade = (
  seq: number,
  side: "buy" | "sell",
  sol: number,
  wallet: string,
  atMs: number,
): LiveTokenTrade => ({
  seq,
  sig: `s${seq}`,
  wallet,
  side,
  sol,
  tokens: 1,
  atMs,
  mcapUsd: null,
});

describe("mergeHistory", () => {
  it("keeps trades past the feed's window, each once, oldest first, the newest max", () => {
    const kept = [trade(1, "buy", 1, "a", 100), trade(2, "sell", 1, "b", 200)];
    // A restarted feed sends its window again, reaching back before the newest kept trade.
    const out = mergeHistory(kept, [
      trade(2, "sell", 1, "b", 200),
      trade(0, "buy", 1, "c", 50),
      trade(3, "buy", 1, "d", 300),
    ]);
    expect(out.map((t) => t.sig)).toEqual(["s0", "s1", "s2", "s3"]);
    expect(mergeHistory(out, [trade(4, "buy", 1, "e", 400)], 3).map((t) => t.sig)).toEqual([
      "s2",
      "s3",
      "s4",
    ]);
    expect(mergeHistory(kept, [trade(1, "buy", 1, "a", 100)])).toBe(kept);
  });
});

describe("live trades", () => {
  it("tallies the buys and sells since a moment", () => {
    const t = tallyTrades(
      [trade(1, "buy", 1, "a", 0), trade(2, "buy", 0.5, "b", 100), trade(3, "sell", 2, "a", 200)],
      50,
    );
    expect(t).toEqual({ buys: 1, sells: 1, solIn: 0.5, solOut: 2, traders: 2 });
  });

  it("writes SOL and ages short", () => {
    expect(solText(0.0004)).toBe("<0.001");
    expect(solText(0.0456)).toBe("0.046");
    expect(solText(1.234)).toBe("1.23");
    expect(solText(150.4)).toBe("150");
    expect(sinceText(1_000, 1_500)).toBe("now");
    expect(sinceText(0, 12_000)).toBe("12s");
    expect(sinceText(0, 4 * 60_000)).toBe("4m");
    expect(sinceText(0, 2 * 3_600_000)).toBe("2h");
  });

  it("labels the coin's holders and flagged wallets", () => {
    const coin = coinLabels(
      {
        linkedHolders: [
          { wallet: "h1", sniper: true },
          { wallet: "h2", fresh: true, cexFunder: "cex" },
          null,
        ],
        linkedClusters: [{ funder: "f", wallets: [{ wallet: "h1" }] }],
        sameTimeClusters: [{ wallets: [{ wallet: "h2" }] }],
      },
      [
        { wallet: "k", tags: ["kol"] },
        { wallet: "ks", tags: ["kol"], knownSideOf: "k" },
        { wallet: "s", tags: ["side"], side: { kind: "probable" } },
        { wallet: "d", tags: ["creator", "dumper"] },
      ],
    );
    expect([...coin.get("h1")!].sort()).toEqual(["cluster", "holder", "sniper"]);
    expect([...coin.get("h2")!].sort()).toEqual(["cexFunded", "fresh", "holder", "together"]);
    expect([...coin.get("f")!]).toEqual(["cluster"]);
    expect([...coin.get("k")!]).toEqual(["kol"]);
    expect([...coin.get("ks")!]).toEqual(["known"]);
    expect([...coin.get("s")!]).toEqual(["probable"]);
    expect([...coin.get("d")!].sort()).toEqual(["dev", "risky"]);
  });

  it("adds the labels a trader's name and KOL ties carry", () => {
    const coin = coinLabels(null, []);
    expect([...traderLabels("a", coin, { source: "kol", mine: true }, undefined)].sort()).toEqual([
      "kol",
      "mine",
    ]);
    expect([...traderLabels("a", coin, { source: "identity", service: true }, undefined)]).toEqual([
      "exchange",
    ]);
    expect([...traderLabels("a", coin, { source: "pumpfun" }, [{ funded: true }, {}])].sort()).toEqual([
      "funded",
      "probable",
      "username",
    ]);
  });

  it("filters by size and by any picked label", () => {
    const trades = [trade(1, "buy", 0.2, "a", 0), trade(2, "buy", 2, "b", 0), trade(3, "sell", 8, "a", 0)];
    const labels = (w: string) => new Set(w === "a" ? (["kol"] as const) : []);
    expect(filterTrades(trades, NO_FILTER, labels)).toBe(trades);
    expect(filterTrades(trades, { minSol: 1, maxSol: 5, labels: [] }, labels).map((t) => t.seq)).toEqual([2]);
    expect(
      filterTrades(trades, { minSol: null, maxSol: null, labels: ["kol"] }, labels).map((t) => t.seq),
    ).toEqual([1, 3]);
    expect(
      filterTrades(trades, { minSol: 1, maxSol: null, labels: ["kol", "dev"] }, labels).map((t) => t.seq),
    ).toEqual([3]);
  });

  it("reads a stored filter, dropping what it doesn't know", () => {
    expect(parseFilter(null)).toEqual(NO_FILTER);
    expect(parseFilter("nope")).toEqual(NO_FILTER);
    expect(parseFilter('{"minSol":0.5,"maxSol":-1,"labels":["kol","bogus","kol",3]}')).toEqual({
      minSol: 0.5,
      maxSol: null,
      labels: ["kol"],
    });
  });
});
