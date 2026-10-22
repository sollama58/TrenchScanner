import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Only `api` is needed from ./api; each test resolves the requests by hand.
const requests: { path: string; resolve: (data: unknown) => void; reject: (err: unknown) => void }[] = [];
vi.mock("./api", () => ({
  api: (path: string) =>
    new Promise((resolve, reject) => {
      requests.push({ path, resolve, reject });
    }),
}));
let access: boolean | null = true;
vi.mock("./cache", () => ({
  peek: () => (access === null ? null : { data: { hasAccess: access }, at: 0, restored: false }),
}));

const { loadDeskRewardMeta, keptDeskRewardMeta, resetDeskRewardMeta, META_TTL_MS } =
  await import("./deskRewardMeta");

const NVDA = "So11111111111111111111111111111111111111112";
const TSLA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const patch = (mint: string, symbol: string) => ({
  mint,
  symbol,
  name: null,
  imageUrl: null,
  marketCapUsd: null,
  marketCapAt: null,
  volume24hUsd: null,
  liquidityUsd: null,
  holderCount: null,
});

describe("loadDeskRewardMeta", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    requests.length = 0;
    access = true;
    resetDeskRewardMeta();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends one request for the mints several cards want, and shares it", async () => {
    const a = loadDeskRewardMeta([NVDA]);
    const b = loadDeskRewardMeta([NVDA, TSLA]);
    const c = loadDeskRewardMeta([TSLA]);
    vi.advanceTimersByTime(100);
    expect(requests).toHaveLength(1);
    expect(decodeURIComponent(requests[0]!.path)).toBe(`/tokens/search/markets?mints=${NVDA},${TSLA}`);
    requests[0]!.resolve({ hits: [patch(NVDA, "NVDA")] });
    expect((await a).get(NVDA)?.symbol).toBe("NVDA");
    expect([...(await b).keys()]).toEqual([NVDA]);
    expect((await c).size).toBe(0);
  });

  it("keeps hits and misses for the TTL, then asks again", async () => {
    const first = loadDeskRewardMeta([NVDA, TSLA]);
    vi.advanceTimersByTime(100);
    requests[0]!.resolve({ hits: [patch(NVDA, "NVDA")] });
    await first;
    expect(keptDeskRewardMeta(NVDA)?.symbol).toBe("NVDA");
    expect(keptDeskRewardMeta(TSLA)).toBeNull();
    // A remounted card reads what is kept, the miss included, without a request.
    expect((await loadDeskRewardMeta([NVDA, TSLA])).get(NVDA)?.symbol).toBe("NVDA");
    vi.advanceTimersByTime(100);
    expect(requests).toHaveLength(1);
    vi.advanceTimersByTime(META_TTL_MS);
    void loadDeskRewardMeta([TSLA]);
    vi.advanceTimersByTime(100);
    expect(requests).toHaveLength(2);
  });

  it("does not hammer the route after a failed request", async () => {
    const first = loadDeskRewardMeta([NVDA]);
    vi.advanceTimersByTime(100);
    requests[0]!.reject(new Error("429"));
    expect((await first).size).toBe(0);
    void loadDeskRewardMeta([NVDA]);
    vi.advanceTimersByTime(100);
    expect(requests).toHaveLength(1);
  });

  it("asks nothing for a viewer without access", async () => {
    for (const state of [false, null]) {
      access = state;
      expect((await loadDeskRewardMeta([NVDA])).size).toBe(0);
      vi.advanceTimersByTime(100);
    }
    expect(requests).toHaveLength(0);
  });
});
