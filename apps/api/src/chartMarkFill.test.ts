import { describe, expect, it } from "vitest";
import type { PumpFunTradesPage } from "@trenchscanner/core";
import type { FlaggedTradeRow, FlaggedTradeStore } from "./chartFlaggedTrades.js";
import {
  ChartMarkFiller,
  FRESH_MS,
  KEEP_AFTER_OPEN_DAYS,
  PAGES_PER_FILL,
  planFill,
  spanAfter,
  type FillSpan,
  type MarkFillStore,
} from "./chartMarkFill.js";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

describe("planFill", () => {
  it("reads from now back to the start first, then what is new, then back toward the start", () => {
    expect(planFill(NOW - 600 * MIN, { from: null, to: null }, NOW)).toEqual({
      kind: "first",
      cursorAt: NOW,
      stopAt: NOW - 600 * MIN,
    });
    expect(planFill(NOW - 600 * MIN, { from: NOW - 500 * MIN, to: NOW - 60 * MIN }, NOW)).toEqual({
      kind: "newer",
      cursorAt: NOW,
      stopAt: NOW - 60 * MIN,
    });
    expect(planFill(NOW - 600 * MIN, { from: NOW - 500 * MIN, to: NOW - MIN }, NOW)).toEqual({
      kind: "older",
      cursorAt: NOW - 500 * MIN,
      stopAt: NOW - 600 * MIN,
    });
    expect(planFill(NOW - 600 * MIN, { from: NOW - 600 * MIN, to: NOW - FRESH_MS }, NOW)).toBeNull();
  });
});

describe("spanAfter", () => {
  const span: FillSpan = { from: NOW - 500 * MIN, to: NOW - 60 * MIN };
  it("joins a newer read that reached the old span, and lets the old span go when it stopped short", () => {
    const plan = planFill(0, span, NOW)!;
    expect(spanAfter(plan, span, plan.stopAt)).toEqual({ from: span.from, to: NOW });
    expect(spanAfter(plan, span, NOW - 30 * MIN)).toEqual({ from: NOW - 30 * MIN, to: NOW });
  });
  it("extends the span down on an older read", () => {
    const fresh = { from: NOW - 500 * MIN, to: NOW - MIN };
    const plan = planFill(NOW - 600 * MIN, fresh, NOW)!;
    expect(spanAfter(plan, fresh, NOW - 550 * MIN)).toEqual({ from: NOW - 550 * MIN, to: fresh.to });
  });
});

function memoryStore(initial: FillSpan = { from: null, to: null }) {
  const state = { span: initial, keepUntil: null as Date | null, leased: false, calls: 0 };
  const store: MarkFillStore = {
    async keep(_mint, until) {
      state.keepUntil = until;
    },
    async claim() {
      if (state.leased) return null;
      state.leased = true;
      return state.span;
    },
    async release(_mint, span, calls) {
      state.span = span;
      state.leased = false;
      state.calls += calls;
    },
  };
  return { state, store };
}

function flagStore(flagged: string[]) {
  const saved: FlaggedTradeRow[] = [];
  const store: FlaggedTradeStore = {
    async flagged(wallets) {
      return { wallets: new Set(wallets.filter((w) => flagged.includes(w))), creators: new Map() };
    },
    async save(rows) {
      saved.push(...rows);
    },
  };
  return { saved, store };
}

/** Pages of `trades` (newest first), `size` a page, the cursor an index. */
function pagesOf(trades: { wallet: string; atMs: number; tx: string }[], size = 2) {
  const asked: string[] = [];
  const pages = async (_mint: string, cursor: string): Promise<PumpFunTradesPage | null> => {
    asked.push(cursor);
    const from = cursor.startsWith("p:") ? Number(cursor.slice(2)) : 0;
    const slice = trades.slice(from, from + size);
    return {
      trades: slice.map((t) => ({ ...t, side: "buy" as const, sol: 1, tokens: 1 })),
      nextCursor: from + size < trades.length ? `p:${from + size}` : null,
    };
  };
  return { asked, pages };
}

const noSleep = async () => {};

describe("ChartMarkFiller", () => {
  it("saves the flagged wallets' trades between the start and now, and records the span read", async () => {
    const { state, store } = memoryStore();
    const flags = flagStore(["kol"]);
    const { pages } = pagesOf([
      { wallet: "kol", atMs: NOW - MIN, tx: "a" },
      { wallet: "anon", atMs: NOW - 2 * MIN, tx: "b" },
      { wallet: "kol", atMs: NOW - 3 * MIN, tx: "c" },
      { wallet: "kol", atMs: NOW - 20 * MIN, tx: "d" },
    ]);
    const filler = new ChartMarkFiller(store, flags.store, pages, { now: () => NOW, sleep: noSleep });
    expect(await filler.fill("m", NOW - 10 * MIN)).toBe(2);
    expect(flags.saved.map((r) => r.sig)).toEqual(["a", "c"]);
    expect(state.span).toEqual({ from: NOW - 10 * MIN, to: NOW });
    expect(state.calls).toBe(2);
    // Current now: nothing more to read.
    expect(await filler.fill("m", NOW - 10 * MIN)).toBe(0);
    expect(state.calls).toBe(2);
  });

  it("stops at PAGES_PER_FILL and goes on from where it stopped on the next open", async () => {
    const { state, store } = memoryStore();
    const flags = flagStore(["kol"]);
    const trades = Array.from({ length: (PAGES_PER_FILL + 5) * 2 }, (_, i) => ({
      wallet: "kol",
      atMs: NOW - (i + 1) * 1_000,
      tx: `t${i}`,
    }));
    const { asked, pages } = pagesOf(trades);
    const filler = new ChartMarkFiller(store, flags.store, pages, { now: () => NOW, sleep: noSleep });
    await filler.fill("m", 0);
    expect(asked).toHaveLength(PAGES_PER_FILL);
    const reached = NOW - PAGES_PER_FILL * 2 * 1_000;
    expect(state.span).toEqual({ from: reached, to: NOW });
    // The next read starts at the span's lower end (the fake's cursor restarts at the newest page).
    const plan = planFill(0, state.span, NOW);
    expect(plan).toEqual({ kind: "older", cursorAt: reached, stopAt: 0 });
  });

  it("keeps the span when the first page fails, and marks a coin Pump.fun doesn't have as read", async () => {
    const failing = memoryStore({ from: NOW - 100 * MIN, to: NOW - 60 * MIN });
    const filler = new ChartMarkFiller(
      failing.store,
      flagStore([]).store,
      async () => {
        throw new Error("429");
      },
      { now: () => NOW, sleep: noSleep },
    );
    await filler.fill("m", NOW - 200 * MIN);
    expect(failing.state.span).toEqual({ from: NOW - 100 * MIN, to: NOW - 60 * MIN });
    expect(failing.state.leased).toBe(false);

    const missing = memoryStore();
    const none = new ChartMarkFiller(missing.store, flagStore([]).store, async () => null, {
      now: () => NOW,
      sleep: noSleep,
    });
    await none.fill("m", NOW - 200 * MIN);
    expect(missing.state.span).toEqual({ from: NOW - 200 * MIN, to: NOW });
  });

  it("an open keeps the coin's marks 14 days and fills it, at most once an hour", async () => {
    const { state, store } = memoryStore();
    let t = NOW;
    let reads = 0;
    let filled = 0;
    const filler = new ChartMarkFiller(
      store,
      flagStore(["kol"]).store,
      async () => {
        reads += 1;
        return {
          trades: [{ wallet: "kol", side: "buy", sol: 1, tokens: 1, atMs: t - MIN, tx: `x${reads}` }],
          nextCursor: null,
        };
      },
      { now: () => t, sleep: noSleep },
    );
    filler.open("m", NOW - 10 * MIN, () => (filled += 1));
    await new Promise((r) => setTimeout(r, 0));
    await filler.drain();
    expect(state.keepUntil?.getTime()).toBe(NOW + KEEP_AFTER_OPEN_DAYS * 24 * 3_600_000);
    expect(reads).toBe(1);
    expect(filled).toBe(1);

    t = NOW + 30 * MIN;
    filler.open("m", NOW - 10 * MIN);
    await new Promise((r) => setTimeout(r, 0));
    expect(reads).toBe(1);
    expect(state.keepUntil?.getTime()).toBe(NOW + KEEP_AFTER_OPEN_DAYS * 24 * 3_600_000);

    t = NOW + 61 * MIN;
    filler.open("m", NOW - 10 * MIN);
    await new Promise((r) => setTimeout(r, 0));
    await filler.drain();
    expect(state.keepUntil?.getTime()).toBe(t + KEEP_AFTER_OPEN_DAYS * 24 * 3_600_000);
    expect(reads).toBe(2);
  });
});
