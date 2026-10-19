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
const { cachedGet, invalidate, peek, cacheSize, MAX_ENTRIES, firstScreenLoaded } = await import("./cache");

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

describe("boot requests (window.__boot)", () => {
  const w = globalThis as { __boot?: Record<string, Promise<Response> | undefined> };
  beforeEach(() => {
    requests.length = 0;
    invalidate();
  });
  afterEach(() => {
    delete w.__boot;
  });

  it("keeps the sign-in page's public reads when a 401 drops the account's", async () => {
    // The first visit's session check comes back 401 and drops everything for the old account;
    // the showcase and feed read the same for anyone, and asking again cost a second download.
    w.__boot = {
      "/auth/me": Promise.resolve(new Response("{}", { status: 401 })),
      "/settings": Promise.resolve(new Response("{}")),
      "/guest/best": Promise.resolve(new Response(JSON.stringify({ match: null }))),
      "/config/free-access": Promise.resolve(new Response("{}")),
      "/auth/privy/config": Promise.resolve(new Response("{}")),
    };
    invalidate();
    expect(Object.keys(w.__boot).sort()).toEqual([
      "/auth/privy/config",
      "/config/free-access",
      "/guest/best",
    ]);
    expect(await cachedGet("/guest/best")).toEqual({ match: null });
    expect(requests).toHaveLength(0);
  });

  it("still drops a public read when its own prefix is invalidated", () => {
    w.__boot = { "/guest/feed?page=1": Promise.resolve(new Response("{}")) };
    invalidate("/guest/");
    expect(w.__boot).toEqual({});
  });

  it("settles once every boot body is in, leaving the bodies for the app to read", async () => {
    let finish!: (res: Response) => void;
    w.__boot = { "/guest/feed?page=1": new Promise<Response>((r) => (finish = r)) };
    let settled = false;
    const done = firstScreenLoaded().then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    finish(new Response(JSON.stringify({ matches: [1] })));
    await done;
    expect(await cachedGet("/guest/feed?page=1")).toEqual({ matches: [1] });
  });

  it("does not wait forever on a request that hangs", async () => {
    vi.useFakeTimers();
    w.__boot = { "/health/worker": new Promise<Response>(() => undefined) };
    let settled = false;
    void firstScreenLoaded().then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(8_000);
    expect(settled).toBe(true);
    vi.useRealTimers();
  });
});
