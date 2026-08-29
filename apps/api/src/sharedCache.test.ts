import { describe, expect, it, vi } from "vitest";
import { SharedCache } from "./sharedCache.js";

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
});
