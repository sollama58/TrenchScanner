import type { DiscoveredCoin } from "@trenchscanner/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "../discovery/pumpPortalStream.js";
import {
  fillBandMetadata,
  fillLaunchDetails,
  resetLaunchDetails,
  setLaunchDetailsClock,
  STREAM_MISS_STREAK,
  STREAM_PAUSE_MS,
  STREAM_PROBE,
  takeLaunchDetailStats,
} from "./launchDetails.js";

const at = new Date("2026-10-15T08:00:00Z");
const launch = (mint: string, extra: Partial<StreamEvent> = {}): StreamEvent => ({
  kind: "create",
  mintAddress: mint,
  at,
  ...extra,
});
const coin = (mint: string, extra: Partial<DiscoveredCoin> = {}): DiscoveredCoin => ({
  mintAddress: mint,
  graduated: false,
  hasTwitter: false,
  hasTelegram: false,
  hasWebsite: false,
  description: "",
  ...extra,
});

describe("fillLaunchDetails", () => {
  beforeEach(() => resetLaunchDetails());

  it("reads each launch from Pump.fun, falls back to its metadata, and saves what it found", async () => {
    const coinDetails = vi.fn(async (mint: string) => {
      if (mint === "a") return coin("a", { description: "from pump" });
      if (mint === "b") throw new Error("HTTP 403");
      return null;
    });
    const fetchMetadata = vi.fn(async (mint: string) =>
      coin(mint, { description: "from ipfs", symbol: "IPFS" }),
    );
    const save = vi.fn(async () => {});
    await fillLaunchDetails(
      [
        launch("a"),
        launch("b", { metadataUri: "https://ipfs.io/ipfs/x", symbol: "B" }),
        launch("c"),
        { kind: "migrate", mintAddress: "d", at },
      ],
      { coinDetails },
      save,
      fetchMetadata,
    );
    expect(coinDetails).toHaveBeenCalledTimes(3);
    expect(fetchMetadata).toHaveBeenCalledTimes(1);
    const saved = (save.mock.calls[0] as unknown as [DiscoveredCoin[]])[0];
    expect(saved.map((c) => [c.mintAddress, c.description, c.symbol]).sort()).toEqual([
      ["a", "from pump", undefined],
      ["b", "from ipfs", "B"],
    ]);
    expect(takeLaunchDetailStats()).toEqual({
      asked: 3,
      fromPumpFun: 1,
      fromMetadata: 1,
      fromDas: 0,
      missing: 1,
      dropped: 0,
      deferred: 0,
    });
  });

  it("reads each mint once", async () => {
    const coinDetails = vi.fn(async (mint: string) => coin(mint));
    const save = vi.fn(async () => {});
    await fillLaunchDetails([launch("x")], { coinDetails }, save);
    await fillLaunchDetails([launch("x"), launch("y")], { coinDetails }, save);
    expect(coinDetails.mock.calls.map((c) => c[0])).toEqual(["x", "y"]);
  });

  it("does nothing for no launches", async () => {
    const save = vi.fn(async () => {});
    await fillLaunchDetails([], { coinDetails: vi.fn() }, save);
    expect(save).not.toHaveBeenCalled();
  });

  describe("when neither source answers", () => {
    const refusing = { coinDetails: vi.fn(async () => Promise.reject(new Error("HTTP 403"))) };
    const unreachable = vi.fn(async () => Promise.reject(new Error("HTTP 429")));
    const save = vi.fn(async () => {});
    const withUri = (mint: string) => launch(mint, { metadataUri: `https://ipfs.io/ipfs/${mint}` });
    const many = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => withUri(`${prefix}${i}`));
    let clock = 1_000_000;
    beforeEach(() => {
      clock = 1_000_000;
      setLaunchDetailsClock(() => clock);
      unreachable.mockClear();
    });

    it("pauses the streamed path after a streak of misses, then lets a probe through", async () => {
      await fillLaunchDetails(many("a", STREAM_MISS_STREAK), refusing, save, unreachable);
      expect(unreachable).toHaveBeenCalledTimes(STREAM_MISS_STREAK);
      expect(takeLaunchDetailStats().missing).toBe(STREAM_MISS_STREAK);

      // Paused: nothing is asked, and the launches are not marked as asked.
      await fillLaunchDetails(many("b", 10), refusing, save, unreachable);
      expect(unreachable).toHaveBeenCalledTimes(STREAM_MISS_STREAK);
      expect(takeLaunchDetailStats()).toMatchObject({ asked: 0, deferred: 10 });

      // The pause over: only a probe's worth goes through, the rest is deferred.
      clock += STREAM_PAUSE_MS;
      await fillLaunchDetails(many("b", 10), refusing, save, unreachable);
      expect(unreachable).toHaveBeenCalledTimes(STREAM_MISS_STREAK + STREAM_PROBE);
      expect(takeLaunchDetailStats()).toMatchObject({ asked: STREAM_PROBE, deferred: 10 - STREAM_PROBE });

      // Every probe missed: paused again at once.
      await fillLaunchDetails(many("c", 3), refusing, save, unreachable);
      expect(unreachable).toHaveBeenCalledTimes(STREAM_MISS_STREAK + STREAM_PROBE);
      expect(takeLaunchDetailStats()).toMatchObject({ asked: 0, deferred: 3 });
      expect(save).not.toHaveBeenCalled();
    });

    it("resumes in full once a probe answers", async () => {
      await fillLaunchDetails(many("a", STREAM_MISS_STREAK), refusing, save, unreachable);
      clock += STREAM_PAUSE_MS;
      const answering = vi.fn(async (mint: string) => coin(mint, { description: "from ipfs" }));
      await fillLaunchDetails(many("d", 10), refusing, save, answering);
      expect(answering).toHaveBeenCalledTimes(STREAM_PROBE);
      takeLaunchDetailStats();
      // Back to normal: the whole batch is read.
      await fillLaunchDetails(many("e", 10), refusing, save, answering);
      expect(answering).toHaveBeenCalledTimes(STREAM_PROBE + 10);
      expect(takeLaunchDetailStats()).toMatchObject({ asked: 10, fromMetadata: 10, deferred: 0 });
    });

    it("counts only launches that had metadata to read towards the streak", async () => {
      // No metadata URI: nothing was asked of a gateway, so these never pause the path.
      const bare = Array.from({ length: STREAM_MISS_STREAK * 2 }, (_, i) => launch(`n${i}`));
      await fillLaunchDetails(bare, refusing, save, unreachable);
      expect(unreachable).not.toHaveBeenCalled();
      takeLaunchDetailStats();
      await fillLaunchDetails(many("f", 2), refusing, save, unreachable);
      expect(unreachable).toHaveBeenCalledTimes(2);
      expect(takeLaunchDetailStats()).toMatchObject({ asked: 2, missing: 2, deferred: 0 });
    });
  });
});

describe("fillBandMetadata", () => {
  beforeEach(() => resetLaunchDetails());

  /** A chain read answering per mint as `answer` says, recording each batch it was asked. */
  const chainReader = (answer: (mint: string) => string | null | "failed") => {
    const batches: string[][] = [];
    const getMetadataUris = vi.fn(async (mints: readonly string[]) => {
      batches.push([...mints]);
      return new Map(mints.map((m) => [m, answer(m)]));
    });
    return { batches, getMetadataUris };
  };

  it("reads in-band coins' URIs off the chain once, in one batch, then their metadata, and saves what it found", async () => {
    const { batches, getMetadataUris } = chainReader((mint) => {
      if (mint === "a") return "https://ipfs.io/ipfs/" + "Q".repeat(46);
      if (mint === "b") return null;
      return "failed";
    });
    const fetchMetadata = vi.fn(async (mint: string) =>
      coin(mint, { description: "from chain", symbol: "X" }),
    );
    const pending = vi.fn(async (mints: readonly string[]) =>
      mints
        .filter((m) => m !== "has")
        .map((m) => ({ mintAddress: m, symbol: m === "a" ? "A" : null, name: null })),
    );
    const save = vi.fn(async () => {});
    await fillBandMetadata(
      ["a", "b", "c", "has"],
      20,
      { helius: { getMetadataUris }, pending, fetchMetadata },
      save,
    );
    // "has" already has a description; a, b and c are read in one chain read (one billed call,
    // not a 10-credit DAS read each: audit 2026-10-27, DA-4); only a has a URI and answers.
    expect(batches.map((b) => [...b].sort())).toEqual([["a", "b", "c"]]);
    expect(fetchMetadata).toHaveBeenCalledTimes(1);
    const saved = (save.mock.calls[0] as unknown as [DiscoveredCoin[]])[0];
    expect(saved.map((c) => [c.mintAddress, c.description, c.symbol])).toEqual([["a", "from chain", "A"]]);
    expect(takeLaunchDetailStats()).toMatchObject({ asked: 3, fromDas: 1, missing: 2 });
    // a and b are not asked again; c (nothing answered) is.
    await fillBandMetadata(
      ["a", "b", "c"],
      20,
      { helius: { getMetadataUris }, pending, fetchMetadata },
      save,
    );
    expect(batches.slice(1)).toEqual([["c"]]);
  });

  it("reads at most perCycle coins a cycle, and none when off", async () => {
    const { batches, getMetadataUris } = chainReader(() => null);
    const pending = async (mints: readonly string[]) =>
      mints.map((m) => ({ mintAddress: m, symbol: null, name: null }));
    const save = vi.fn(async () => {});
    await fillBandMetadata(["a", "b", "c"], 2, { helius: { getMetadataUris }, pending }, save);
    expect(batches).toEqual([["a", "b"]]);
    await fillBandMetadata(["d"], 0, { helius: { getMetadataUris }, pending }, save);
    expect(getMetadataUris).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });
});
