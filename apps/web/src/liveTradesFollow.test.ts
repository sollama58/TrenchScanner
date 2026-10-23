import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The follow is the paid chain stream on the API (Helius audit 2026-10-22 H-2): each ask for
// /trades/live is recorded here, and answered by hand.
const asks: { path: string; resolve: (a: unknown) => void }[] = [];
/** Each wait the feed set before its next ask. */
const delays: number[] = [];
vi.mock("./api", () => ({
  FEED_TIMEOUT_MS: 30_000,
  api: (path: string) => new Promise((resolve) => asks.push({ path, resolve })),
}));

const { feedState, followFeed, watchFeed } = await import("./liveTrades");

beforeAll(() => {
  vi.stubGlobal("window", {
    setTimeout: (_fn: () => void, ms: number) => {
      delays.push(ms);
      return 0;
    },
    clearTimeout: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  vi.stubGlobal("document", { visibilityState: "visible" });
});
afterAll(() => {
  vi.unstubAllGlobals();
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("following a coin's live trades", () => {
  it("never asks for a coin only the chart's marks watch", async () => {
    let told = 0;
    const stop = watchFeed("/tokens/a", () => (told += 1));
    await flush();
    expect(asks).toHaveLength(0);
    expect(feedState("/tokens/a").status).toBeNull();
    stop();
    expect(told).toBe(0);
  });

  it("lets the marks read the Live trades tab's feed, and keep its trades once the tab closes", async () => {
    let told = 0;
    const unwatch = watchFeed("/tokens/b", () => (told += 1));
    const unfollow = followFeed("/tokens/b", () => {});
    expect(told).toBe(1);
    expect(asks.map((a) => a.path)).toEqual(["/tokens/b/trades/live?after=0&wait=1"]);
    asks[0]!.resolve({
      status: "live",
      since: 1,
      cursor: 1,
      supply: 1_000,
      trades: [{ seq: 1, sig: "s1", wallet: "kol", side: "buy", sol: 1, tokens: 1, atMs: 5, mcapUsd: null }],
    });
    await flush();
    expect(told).toBe(2);
    expect(feedState("/tokens/b").status).toBe("live");
    unfollow();
    expect(told).toBe(3);
    const after = feedState("/tokens/b");
    // Nothing is followed now: no status (the holder shares stop using it), the trades read stay.
    expect(after.status).toBeNull();
    expect(after.trades).toEqual([]);
    expect(after.history.map((t) => t.sig)).toEqual(["s1"]);
    expect(after.supply).toBe(1_000);
    unwatch();
  });

  it("says a busy coin is waiting for a slot, not off, and asks again sooner", async () => {
    const unfollow = followFeed("/tokens/c", () => {});
    const ask = asks.find((a) => a.path.startsWith("/tokens/c/"))!;
    delays.length = 0;
    ask.resolve({ status: "unavailable", reason: "busy", since: null, cursor: 0, trades: [], held: false });
    await flush();
    expect(feedState("/tokens/c")).toMatchObject({ status: "unavailable", busy: true });
    expect(delays).toEqual([15_000]);
    unfollow();
  });
});
