import { describe, expect, it, vi } from "vitest";
import {
  applyPollResult,
  everyWhileVisible,
  pollIsStale,
  pollMountMaxAge,
  pollWant,
  shouldPollOnVisible,
  viewForMint,
  type PollHeld,
} from "./hooks";

/** What the bubble map draws: a stale answer is the previous coin and is not shown. */
function visibleMap<T>(held: PollHeld<T> | null, want: string): T | null {
  return pollIsStale(held, want) ? null : (held?.data ?? null);
}

const holders = (mint: string) => ({ mint, wallets: [`wallet-${mint}`] });

describe("a token switch ignores in-flight holder reads", () => {
  const want = (mint: string) => pollWant(`/tokens/${mint}/bubble-holders`, "0");

  it("keeps a slow response for the previous coin from becoming the coin on screen", () => {
    const a = want("mintA");
    const b = want("mintB");
    let held: PollHeld<ReturnType<typeof holders>> | null = null;
    held = applyPollResult(held, a, { for: a, data: holders("mintA"), at: 1 });
    expect(visibleMap(held, a)).toEqual(holders("mintA"));

    // The reader opens mint B. A's payload is still held, and it is stale.
    expect(visibleMap(held, b)).toBeNull();
    expect(pollIsStale(held, b)).toBe(true);

    // A's request resolves after the switch. It must not be filed as B's holders.
    held = applyPollResult(held, b, { for: a, data: holders("mintA-late"), at: 2 });
    expect(held?.data).toEqual(holders("mintA"));
    expect(visibleMap(held, b)).toBeNull();

    held = applyPollResult(held, b, { for: b, data: holders("mintB"), at: 3 });
    expect(visibleMap(held, b)).toEqual(holders("mintB"));
    expect(pollIsStale(held, b)).toBe(false);
  });

  it("drops an intermediate coin when the reader has already moved on", () => {
    const a = want("mintA");
    const b = want("mintB");
    const c = want("mintC");
    let held: PollHeld<ReturnType<typeof holders>> | null = applyPollResult(null, a, {
      for: a,
      data: holders("mintA"),
      at: 1,
    });

    // A → B → C before either later read lands. B's response arrives first, then A's, then C's.
    held = applyPollResult(held, c, { for: b, data: holders("mintB"), at: 2 });
    held = applyPollResult(held, c, { for: a, data: holders("mintA-late"), at: 3 });
    expect(visibleMap(held, c)).toBeNull();
    expect(held?.data).toEqual(holders("mintA"));

    held = applyPollResult(held, c, { for: c, data: holders("mintC"), at: 4 });
    expect(visibleMap(held, c)).toEqual(holders("mintC"));

    // A response that was already in flight for B still must not replace C.
    held = applyPollResult(held, c, { for: b, data: holders("mintB-late"), at: 5 });
    expect(visibleMap(held, c)).toEqual(holders("mintC"));
  });

  it("does not let the previous coin's failure clear the coin now showing", () => {
    const a = want("mintA");
    const b = want("mintB");
    const held = applyPollResult(applyPollResult(null, a, { for: a, data: holders("mintA"), at: 1 }), b, {
      for: a,
      error: true,
    });
    expect(held?.data).toEqual(holders("mintA"));
    expect(visibleMap(held, b)).toBeNull();
  });

  it("applies a fresh read of the coin that is open", () => {
    const a = want("mintA");
    const first = applyPollResult(null, a, { for: a, data: holders("mintA"), at: 1 });
    const next = applyPollResult(first, a, { for: a, data: holders("mintA-new"), at: 2 });
    expect(visibleMap(next, a)).toEqual(holders("mintA-new"));
    expect(pollIsStale(next, a)).toBe(false);
  });
});

describe("chart poll timing", () => {
  it("always refetches the chart on mount and when the tab comes back", () => {
    expect(pollMountMaxAge("/tokens/abc/chart", false)).toBe(0);
    expect(pollMountMaxAge("/tokens/abc/chart", true)).toBe(-1);
    expect(pollMountMaxAge("/tokens/abc/profile", false)).toBe(10_000);
    const now = Date.now();
    expect(shouldPollOnVisible("/tokens/abc/chart", now, 30_000)).toBe(true);
    expect(shouldPollOnVisible("/tokens/abc/profile", now, 30_000)).toBe(false);
    expect(shouldPollOnVisible("/tokens/abc/profile", now - 60_000, 30_000)).toBe(true);
  });
});

describe("a lookup view is only the mint that was opened", () => {
  const body = (mint: string) => ({ mint, card: { token: { mintAddress: mint } } });

  it("hides the previous coin while the next lookup is in flight, and a mismatched payload", () => {
    expect(viewForMint("mintB", body("mintA"), true)).toBeNull();
    expect(viewForMint("mintB", body("mintA"), false)).toBeNull();
    expect(viewForMint("mintB", null, false)).toBeNull();
    expect(viewForMint("mintB", body("mintB"), false)?.card.token.mintAddress).toBe("mintB");
  });
});

describe("everyWhileVisible", () => {
  it("skips ticks in a hidden tab and catches up on return", () => {
    vi.useFakeTimers();
    const listeners = new Set<() => void>();
    const doc = {
      visibilityState: "visible",
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    };
    vi.stubGlobal("document", doc);
    try {
      let runs = 0;
      const stop = everyWhileVisible(() => (runs += 1), 30_000);
      vi.advanceTimersByTime(30_000);
      expect(runs).toBe(1);
      doc.visibilityState = "hidden";
      vi.advanceTimersByTime(120_000);
      expect(runs).toBe(1);
      doc.visibilityState = "visible";
      for (const fn of listeners) fn();
      expect(runs).toBe(2);
      // Back again before another run is due: nothing extra.
      for (const fn of listeners) fn();
      expect(runs).toBe(2);
      stop();
      expect(listeners.size).toBe(0);
      vi.advanceTimersByTime(60_000);
      expect(runs).toBe(2);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
