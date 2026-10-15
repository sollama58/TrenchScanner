import { describe, expect, it } from "vitest";
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
});
