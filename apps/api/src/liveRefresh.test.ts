import { describe, expect, it } from "vitest";
import { DexScreenerClient } from "@trenchscanner/core";
import { OnDemandLiveRefresher, type RefreshableToken } from "./liveRefresh.js";

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 7, 27, 12, 0, 0);

/** selectDue is pure - it never touches the network, so a real client here is inert. */
function refresher(limit = 12) {
  return new OnDemandLiveRefresher(new DexScreenerClient(), { maxAgeMs: MINUTE, limit });
}

function token(mint: string, liveDataAgoMs: number | null): RefreshableToken {
  return {
    id: `id-${mint}`,
    mintAddress: mint,
    liveDataAt: liveDataAgoMs === null ? null : new Date(NOW - liveDataAgoMs),
  };
}

const mints = (tokens: RefreshableToken[]) => tokens.map((t) => t.mintAddress);

describe("OnDemandLiveRefresher.selectDue", () => {
  it("picks up a token that has never been refreshed", () => {
    expect(mints(refresher().selectDue([token("A", null)], NOW))).toEqual(["A"]);
  });

  it("picks up a token whose reading has aged past the cadence", () => {
    expect(mints(refresher().selectDue([token("A", 90_000)], NOW))).toEqual(["A"]);
  });

  it("skips a token that is already as fresh as the worker ever makes it", () => {
    // The whole point: a page sitting there polling every few seconds must not produce a
    // DexScreener call every few seconds.
    expect(refresher().selectDue([token("A", 10_000)], NOW)).toEqual([]);
  });

  it("treats a reading exactly at the cadence as due", () => {
    expect(mints(refresher().selectDue([token("A", MINUTE)], NOW))).toEqual(["A"]);
  });

  it("requests a token once even when a page holds several matches on it", () => {
    const page = [token("A", null), token("A", null), token("B", null)];
    expect(mints(refresher().selectDue(page, NOW))).toEqual(["A", "B"]);
  });

  it("caps a single request at the configured limit", () => {
    const page = Array.from({ length: 30 }, (_, i) => token(`M${i}`, null));
    expect(refresher(12).selectDue(page, NOW)).toHaveLength(12);
  });

  it("returns nothing for an empty page", () => {
    expect(refresher().selectDue([], NOW)).toEqual([]);
  });
});

describe("OnDemandLiveRefresher cooldown", () => {
  const GHOST = "GhostMint1111111111111111111111111111111111";

  it("does not re-request a token DexScreener had no data for", async () => {
    // The failure mode this guards: a token DexScreener doesn't know about never gets liveDataAt
    // written, so it stays "stale" forever and would otherwise be looked up again on every single
    // poll. The cooldown keys off the *attempt*, not the result. This does a real lookup against
    // a mint that doesn't exist - DexScreener answers, with nothing in it.
    const r = refresher();
    expect(await r.refresh([token(GHOST, null)], NOW)).toBe(1);
    expect(r.selectDue([token(GHOST, null)], NOW)).toEqual([]);
  });

  it("still serves other tokens on the page while one is cooling down", async () => {
    const r = refresher();
    await r.refresh([token(GHOST, null)], NOW);
    expect(mints(r.selectDue([token(GHOST, null), token("B", null)], NOW))).toEqual(["B"]);
  });

  it("lets a token through again once the cooldown has elapsed", async () => {
    const r = refresher();
    await r.refresh([token(GHOST, null)], NOW);

    expect(r.selectDue([token(GHOST, null)], NOW + 30_000)).toEqual([]);
    expect(mints(r.selectDue([token(GHOST, null)], NOW + MINUTE))).toEqual([GHOST]);
  });

  it("refreshes nothing, and calls nothing, when the page is already fresh", async () => {
    const r = refresher();
    expect(await r.refresh([token("A", 5_000)], NOW)).toBe(0);
  });
});
