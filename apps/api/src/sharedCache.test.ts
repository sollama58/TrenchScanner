import { describe, expect, it, vi } from "vitest";
import { SharedCache, SharedCacheMap } from "./sharedCache.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("SharedCache", () => {
  it("runs the producer once for a burst of concurrent callers", async () => {
    // The whole point: at 300 concurrent readers of one shared feed, 299 of them must not each
    // run the query.
    const cache = new SharedCache<number>(1_000);
    let runs = 0;
    const produce = async () => {
      runs += 1;
      await tick();
      return 42;
    };

    const results = await Promise.all(Array.from({ length: 300 }, () => cache.get(produce)));

    expect(runs).toBe(1);
    expect(results).toEqual(Array.from({ length: 300 }, () => 42));
  });

  it("serves from cache until the TTL lapses, then produces again", async () => {
    vi.useFakeTimers();
    try {
      const cache = new SharedCache<number>(3_000);
      let runs = 0;
      const produce = async () => ++runs;

      expect(await cache.get(produce)).toBe(1);
      vi.setSystemTime(Date.now() + 2_999);
      expect(await cache.get(produce)).toBe(1);

      vi.setSystemTime(Date.now() + 2);
      expect(await cache.get(produce)).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not stampede at the moment the entry expires", async () => {
    // The failure this guards against is specifically timed: a plain TTL cache is fine until the
    // instant it lapses, at which point every waiting caller misses at once.
    vi.useFakeTimers();
    try {
      const cache = new SharedCache<number>(1_000);
      let runs = 0;
      const produce = async () => {
        runs += 1;
        return runs;
      };

      await cache.get(produce);
      vi.setSystemTime(Date.now() + 1_001);
      await Promise.all(Array.from({ length: 100 }, () => cache.get(produce)));

      expect(runs).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("serves the last good value when a refresh fails", async () => {
    const cache = new SharedCache<string>(0);
    expect(await cache.get(async () => "good")).toBe("good");

    // TTL 0 means the next call always refreshes - so this exercises the failure path directly.
    await expect(
      cache.get(async () => {
        throw new Error("database is down");
      }),
    ).resolves.toBe("good");
  });

  it("propagates the error when there is nothing cached to fall back to", async () => {
    // A cold cache has no better answer than the truth.
    const cache = new SharedCache<string>(1_000);
    await expect(
      cache.get(async () => {
        throw new Error("database is down");
      }),
    ).rejects.toThrow("database is down");
  });

  it("recovers on the next call after a failure, rather than wedging", async () => {
    // Regression guard: the in-flight promise has to be cleared on the rejection path too, or one
    // failed refresh would be handed to every caller forever.
    const cache = new SharedCache<string>(1_000);
    await expect(cache.get(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(cache.get(async () => "recovered")).resolves.toBe("recovered");
  });

  it("does not store or share a fill that was already running when clear() was called", async () => {
    // A new alert's NOTIFY clears the cache while a fill that read the database just before the
    // alert is still running. That fill must not be cached, and readers arriving after the clear
    // must get a fresh read rather than joining the stale one.
    const cache = new SharedCache<string>(60_000);
    let release!: (v: string) => void;
    const stale = cache.get(() => new Promise<string>((r) => (release = r)));
    cache.clear();
    const fresh = cache.get(async () => "after-alert");
    release("before-alert");
    expect(await stale).toBe("before-alert");
    expect(await fresh).toBe("after-alert");
    expect(await cache.get(async () => "unused")).toBe("after-alert");
  });

  it("with stale-while-revalidate, answers from the expired value at once and refreshes behind it", async () => {
    vi.useFakeTimers();
    try {
      const cache = new SharedCache<string>(1_000, { staleWhileRevalidateMs: 10_000 });
      await cache.get(async () => "old");
      vi.setSystemTime(Date.now() + 1_500);

      let release!: (v: string) => void;
      let runs = 0;
      const slow = () => {
        runs += 1;
        return new Promise<string>((r) => (release = r));
      };
      // Neither reader waits on the refill, and the refill runs once.
      expect(await cache.get(slow)).toBe("old");
      expect(await cache.get(slow)).toBe("old");
      expect(runs).toBe(1);

      release("new");
      await vi.advanceTimersByTimeAsync(0);
      expect(await cache.get(slow)).toBe("new");
      expect(runs).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("past the stale window, waits for a fresh value like a cold cache", async () => {
    vi.useFakeTimers();
    try {
      const cache = new SharedCache<string>(1_000, { staleWhileRevalidateMs: 10_000 });
      await cache.get(async () => "old");
      vi.setSystemTime(Date.now() + 11_001);
      expect(await cache.get(async () => "new")).toBe("new");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps serving the stale value when its background refresh fails", async () => {
    vi.useFakeTimers();
    try {
      const cache = new SharedCache<string>(1_000, { staleWhileRevalidateMs: 10_000 });
      await cache.get(async () => "old");
      vi.setSystemTime(Date.now() + 1_500);
      expect(await cache.get(async () => Promise.reject(new Error("db down")))).toBe("old");
      await vi.advanceTimersByTimeAsync(0);
      expect(await cache.get(async () => "new")).toBe("old");
      // The failed refresh cleared itself, so the next reader's refresh went through.
      await vi.advanceTimersByTimeAsync(0);
      expect(await cache.get(async () => "unused")).toBe("new");
    } finally {
      vi.useRealTimers();
    }
  });

  it("warm() fills a cold cache once, and never rejects", async () => {
    const cache = new SharedCache<string>(60_000);
    let runs = 0;
    cache.warm(async () => {
      runs += 1;
      return "warmed";
    });
    cache.warm(async () => "second");
    expect(await cache.get(async () => "unused")).toBe("warmed");
    expect(runs).toBe(1);

    const failing = new SharedCache<string>(60_000);
    failing.warm(async () => Promise.reject(new Error("boom")));
    await tick();
    await expect(failing.get(async () => "after")).resolves.toBe("after");
  });
});

describe("SharedCacheMap", () => {
  it("shares one fill per key and evicts the least recently used key past its cap", async () => {
    const caches = new SharedCacheMap<number>(60_000, 2);
    let fills = 0;
    const fill = async () => ++fills;
    expect(await caches.for("a").get(fill)).toBe(1);
    expect(await caches.for("a").get(fill)).toBe(1);
    expect(await caches.for("b").get(fill)).toBe(2);
    // Touching "a" makes "b" the oldest, so a third key evicts "b", not "a".
    expect(await caches.for("a").get(fill)).toBe(1);
    expect(await caches.for("c").get(fill)).toBe(3);
    expect(caches.size).toBe(2);
    expect(await caches.for("a").get(fill)).toBe(1);
    expect(await caches.for("b").get(fill)).toBe(4);
  });

  it("clears only the keys under a prefix", async () => {
    const caches = new SharedCacheMap<number>(60_000, 10);
    let fills = 0;
    const fill = async () => ++fills;
    await caches.for("alice:24").get(fill);
    await caches.for("alice:48").get(fill);
    await caches.for("bob:24").get(fill);
    caches.clear("alice:");
    expect(await caches.for("alice:24").get(fill)).toBe(4);
    expect(await caches.for("alice:48").get(fill)).toBe(5);
    expect(await caches.for("bob:24").get(fill)).toBe(3);
    caches.clear();
    expect(await caches.for("bob:24").get(fill)).toBe(6);
  });
});
