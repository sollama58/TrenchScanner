import type { DiscoveredCoin } from "@trenchscanner/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "../discovery/pumpPortalStream.js";
import {
  fillBandMetadata,
  fillLaunchDetails,
  resetLaunchDetails,
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
});

describe("fillBandMetadata", () => {
  beforeEach(() => resetLaunchDetails());

  it("reads in-band coins' URIs off the chain once, then their metadata, and saves what it found", async () => {
    const getAssetMetadataUri = vi.fn(async (mint: string) => {
      if (mint === "a") return "https://ipfs.io/ipfs/" + "Q".repeat(46);
      if (mint === "b") return null;
      return "failed" as const;
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
      { helius: { getAssetMetadataUri }, pending, fetchMetadata },
      save,
    );
    // "has" already has a description; a, b and c are read; only a has a URI and answers.
    expect(getAssetMetadataUri.mock.calls.map((c) => c[0]).sort()).toEqual(["a", "b", "c"]);
    expect(fetchMetadata).toHaveBeenCalledTimes(1);
    const saved = (save.mock.calls[0] as unknown as [DiscoveredCoin[]])[0];
    expect(saved.map((c) => [c.mintAddress, c.description, c.symbol])).toEqual([["a", "from chain", "A"]]);
    expect(takeLaunchDetailStats()).toMatchObject({ asked: 3, fromDas: 1, missing: 2 });
    // a and b are not asked again; c (nothing answered) is.
    await fillBandMetadata(
      ["a", "b", "c"],
      20,
      { helius: { getAssetMetadataUri }, pending, fetchMetadata },
      save,
    );
    expect(getAssetMetadataUri.mock.calls.map((c) => c[0])).toEqual(["a", "b", "c", "c"]);
  });

  it("reads at most perCycle coins a cycle, and none when off", async () => {
    const getAssetMetadataUri = vi.fn(async () => null);
    const pending = async (mints: readonly string[]) =>
      mints.map((m) => ({ mintAddress: m, symbol: null, name: null }));
    const save = vi.fn(async () => {});
    await fillBandMetadata(["a", "b", "c"], 2, { helius: { getAssetMetadataUri }, pending }, save);
    expect(getAssetMetadataUri).toHaveBeenCalledTimes(2);
    await fillBandMetadata(["d"], 0, { helius: { getAssetMetadataUri }, pending }, save);
    expect(getAssetMetadataUri).toHaveBeenCalledTimes(2);
    expect(save).not.toHaveBeenCalled();
  });
});
