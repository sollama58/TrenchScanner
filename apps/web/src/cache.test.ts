import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The cache only needs `api` from ./api; each test hands it a request it can resolve by hand.
const requests: { path: string; resolve: (data: unknown) => void }[] = [];
vi.mock("./api", () => ({
  api: (path: string) =>
    new Promise((resolve) => {
      requests.push({ path, resolve });
    }),
  parse: async (res: Response) => res.json(),
}));

// The module touches window and localStorage at load; neither exists under node, and the cache is
// written to work without storage anyway.
(globalThis as { window?: unknown }).window = globalThis;
const { cachedGet, invalidate } = await import("./cache");

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
