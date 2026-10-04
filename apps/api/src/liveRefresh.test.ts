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

describe("OnDemandLiveRefresher live tick", () => {
  /** A client whose lookups resolve when the test says so, counting calls. */
  function gatedClient() {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const client = {
      calls: 0,
      getTokensByAddresses: async () => {
        client.calls += 1;
        await gate;
        return [];
      },
    };
    return { client, release: () => release() };
  }

  it("asks for a tighter bound per call, never a looser one", () => {
    const r = refresher();
    expect(mints(r.selectDue([token("A", 10_000)], NOW, 8_000))).toEqual(["A"]);
    expect(r.selectDue([token("A", 5_000)], NOW, 8_000)).toEqual([]);
    // A per-call bound past the configured one is clamped to it.
    expect(mints(r.selectDue([token("A", 90_000)], NOW, 10 * MINUTE))).toEqual(["A"]);
  });

  it("stops looking up once the per-minute call budget is spent", async () => {
    const r = new OnDemandLiveRefresher(
      { getTokensByAddresses: async () => [] } as unknown as DexScreenerClient,
      { maxAgeMs: MINUTE, limit: 12, callsPerMinute: 2 },
    );
    expect(await r.refresh([token("A", null)], NOW)).toBe(1);
    expect(await r.refresh([token("B", null)], NOW + 1)).toBe(1);
    expect(await r.refresh([token("C", null)], NOW + 2)).toBe(0);
    // A minute later the budget has room again.
    expect(await r.refresh([token("C", null)], NOW + MINUTE + 2)).toBe(1);
  });

  it("waits on a lookup another request already started for the same token", async () => {
    const { client, release } = gatedClient();
    const r = new OnDemandLiveRefresher(client as unknown as DexScreenerClient, {
      maxAgeMs: MINUTE,
      limit: 12,
    });
    const pageLoad = r.refresh([token("A", null)]);
    let waited = false;
    const tick = r.refreshAndWait([token("A", null)], { maxAgeMs: 8_000, timeoutMs: 5_000 }).then((v) => {
      waited = true;
      return v;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(waited).toBe(false);
    release();
    expect(await tick).toBe(true);
    await pageLoad;
    // Shared, not repeated.
    expect(client.calls).toBe(1);
  });

  it("answers after the wait budget even if the lookup hangs", async () => {
    const { client, release } = gatedClient();
    const r = new OnDemandLiveRefresher(client as unknown as DexScreenerClient, {
      maxAgeMs: MINUTE,
      limit: 12,
    });
    const started = Date.now();
    expect(await r.refreshAndWait([token("A", null)], { maxAgeMs: 8_000, timeoutMs: 50 })).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    release();
  });

  it("reports nothing to re-read when everything is already fresh", async () => {
    // refreshAndWait reads the clock itself, so this reading is dated against the real one.
    const fresh = { id: "id-A", mintAddress: "A", liveDataAt: new Date(Date.now() - 1_000) };
    expect(await refresher().refreshAndWait([fresh], { maxAgeMs: 8_000, timeoutMs: 50 })).toBe(false);
  });
});

describe("OnDemandLiveRefresher stats", () => {
  it("counts lookups, tokens asked for, and what was served", async () => {
    const r = new OnDemandLiveRefresher(
      { getTokensByAddresses: async () => [] } as unknown as DexScreenerClient,
      { maxAgeMs: MINUTE, limit: 12, callsPerMinute: 1 },
    );
    await r.refresh([token("A", null), token("B", null)]);
    await r.refresh([token("C", null)]);
    r.noteServed(4_000);
    expect(r.stats()).toMatchObject({
      lookups: 1,
      tokens: 2,
      updated: 0,
      overBudget: 1,
      callsLastMinute: 1,
      lookupMs: { sample: 1 },
      servedOldestAgeMs: { p50: 4_000, sample: 1 },
    });
  });
});
