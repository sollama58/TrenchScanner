import { describe, expect, it, vi } from "vitest";
import type { DiscoveredCoin } from "@trenchscanner/core";
import { JupiterLaunchPoller } from "./jupiterLaunchPoller.js";

const coin = (mintAddress: string, marketCapUsd?: number): DiscoveredCoin => ({
  mintAddress,
  marketCapUsd,
  graduated: false,
  hasTwitter: false,
  hasTelegram: false,
  hasWebsite: false,
});

describe("JupiterLaunchPoller", () => {
  it("holds each launch once between drains, with its newest reading", async () => {
    const answers = [
      [coin("A", 3_000), coin("B")],
      [coin("B"), coin("A", 9_000), coin("C")],
    ];
    const poller = new JupiterLaunchPoller({ recentLaunches: async () => answers.shift() ?? [] });
    await poller.poll();
    await poller.poll();
    expect(poller.pendingLaunches()).toEqual(["C", "B", "A"]);
    const drained = poller.drain();
    expect(drained.map((c) => c.mintAddress)).toEqual(["A", "B", "C"]);
    expect(drained[0]!.marketCapUsd).toBe(9_000);
    expect(poller.drain()).toEqual([]);
    expect(poller.takeStats()).toEqual({ polls: 2, failed: 0, found: 3 });
  });

  it("counts a failed read and keeps what it already holds", async () => {
    let fail = false;
    const poller = new JupiterLaunchPoller({
      recentLaunches: async () => {
        if (fail) throw new Error("503");
        return [coin("A")];
      },
    });
    await poller.poll();
    fail = true;
    await poller.poll();
    expect(poller.drain().map((c) => c.mintAddress)).toEqual(["A"]);
    expect(poller.takeStats()).toMatchObject({ polls: 2, failed: 1 });
  });

  it("reads now for the scan, holds what it read, and joins a read under way", async () => {
    let release: (coins: DiscoveredCoin[]) => void = () => {};
    let reads = 0;
    const poller = new JupiterLaunchPoller({
      recentLaunches: () => {
        reads += 1;
        return new Promise((r) => (release = r));
      },
    });
    const timed = poller.poll();
    const now = poller.pollNow();
    release([coin("A")]);
    await timed;
    expect((await now).map((c) => c.mintAddress)).toEqual(["A"]);
    expect(reads).toBe(1);
    expect(poller.drain().map((c) => c.mintAddress)).toEqual(["A"]);
  });

  it("gives none for a failed read", async () => {
    const poller = new JupiterLaunchPoller({
      recentLaunches: async () => {
        throw new Error("503");
      },
    });
    expect(await poller.pollNow()).toEqual([]);
    expect(poller.takeStats()).toMatchObject({ polls: 1, failed: 1 });
  });

  it("puts the next timed read a whole interval after the scan's", async () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      const poller = new JupiterLaunchPoller({
        recentLaunches: async () => {
          reads += 1;
          return [];
        },
      });
      poller.start(15_000);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(reads).toBe(1);
      await poller.pollNow();
      expect(reads).toBe(2);
      // The old schedule would have read at 15 s; the next read is 15 s after the scan's.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(reads).toBe(2);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(reads).toBe(3);
      poller.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
