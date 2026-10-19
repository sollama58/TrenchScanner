import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The cache only needs `api` from ./api; each test hands it a request it can resolve by hand.
const requests: { path: string; init?: RequestInit; resolve: (data: unknown) => void }[] = [];
vi.mock("./api", () => ({
  api: (path: string, init?: RequestInit) =>
    new Promise((resolve) => {
      requests.push({ path, init, resolve });
    }),
  parse: async (res: Response) => res.json(),
}));

// The module touches window and localStorage at load; neither exists under node, and the cache is
// written to work without storage anyway.
(globalThis as { window?: unknown }).window = globalThis;
const { cachedGet, invalidate, peek, cacheSize, MAX_ENTRIES } = await import("./cache");

describe("cachedGet: sharing a request in flight", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    requests.length = 0;
    invalidate();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shares a request in flight with a caller that accepts a cached answer", () => {
    const a = cachedGet("/matches?page=1", 0);
    const b = cachedGet("/matches?page=1", 0);
    expect(requests).toHaveLength(1);
    expect(a).toBe(b);
  });

  it("lets a 'something changed' caller join a request sent within the nudge window", async () => {
    // One SSE nudge wakes the Live tab's reload and the alert notifier's check together; two
    // identical GETs for one event is what this rule removes.
    const first = cachedGet("/matches?page=1", 0);
    vi.advanceTimersByTime(100);
    const second = cachedGet("/matches?page=1", -1);
    expect(requests).toHaveLength(1);
    requests[0]!.resolve({ matches: [1] });
    expect(await first).toEqual({ matches: [1] });
    expect(await second).toEqual({ matches: [1] });
  });

  it("still sends a new request when the one in flight is older than the window", () => {
    cachedGet("/matches?page=1", 0);
    vi.advanceTimersByTime(1_000);
    cachedGet("/matches?page=1", -1);
    expect(requests).toHaveLength(2);
  });

  it("never answers a 'something changed' caller from a settled cache entry", async () => {
    const first = cachedGet("/matches?page=1", 0);
    requests[0]!.resolve({ matches: [] });
    await first;
    cachedGet("/matches?page=1", -1);
    expect(requests).toHaveLength(2);
  });
});

describe("cachedGet: past the browser's HTTP cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    requests.length = 0;
    invalidate();
    vi.advanceTimersByTime(120_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("revalidates a 'something changed' read, and leaves a timed one to the browser", () => {
    void cachedGet("/tokens/x/chart", 0);
    expect(requests[0]!.init).toBeUndefined();
    vi.advanceTimersByTime(1_000);
    void cachedGet("/tokens/x/chart", -1);
    expect(requests[1]!.init?.cache).toBe("no-cache");
  });

  it("revalidates paths under an invalidated prefix for a minute", () => {
    invalidate("/tokens/x/");
    void cachedGet("/tokens/x/bubble-holders", 0);
    void cachedGet("/tokens/y/chart", 0);
    expect(requests.map((r) => r.init?.cache)).toEqual(["no-cache", undefined]);
    vi.advanceTimersByTime(61_000);
    void cachedGet("/tokens/x/profile", 0);
    expect(requests[2]!.init).toBeUndefined();
  });
});

describe("cachedGet: a long-open tab's cache stays bounded", () => {
  beforeEach(() => {
    requests.length = 0;
    invalidate();
  });

  /** Reads `path` and lands its answer. */
  async function read(path: string, data: unknown = { path }) {
    const p = cachedGet(path, 0);
    requests[requests.length - 1]!.resolve(data);
    await p;
  }

  it("drops the least recently read paths past MAX_ENTRIES", async () => {
    // A day of opening coins: each token window reads its own paths once and is closed.
    for (let i = 0; i < MAX_ENTRIES + 50; i += 1) await read(`/tokens/m${i}/chart`);
    expect(cacheSize()).toBe(MAX_ENTRIES);
    expect(peek("/tokens/m0/chart")).toBeNull();
    expect(peek(`/tokens/m${MAX_ENTRIES + 49}/chart`)).not.toBeNull();
  });

  it("keeps what is still being read, a request in flight, and the answers kept between visits", async () => {
    await read("/auth/me", { id: "u1" });
    await read("/tokens/open/chart", { open: true });
    const pending = cachedGet("/tokens/slow/chart", 0);
    for (let i = 0; i < MAX_ENTRIES + 50; i += 1) {
      await read(`/tokens/m${i}/chart`);
      // The open window re-reads its chart each poll.
      if (i % 20 === 0) expect(peek("/tokens/open/chart")).not.toBeNull();
    }
    expect(peek("/auth/me")).toEqual({ data: { id: "u1" }, at: expect.any(Number), restored: false });
    expect(peek("/tokens/open/chart")?.data).toEqual({ open: true });
    // Still in flight: shared with the next caller rather than sent twice.
    const sent = requests.length;
    expect(cachedGet("/tokens/slow/chart", 0)).toBe(pending);
    expect(requests).toHaveLength(sent);
  });
});
