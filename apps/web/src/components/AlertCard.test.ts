import { describe, expect, it } from "vitest";
import type { Card } from "../api";
import { shownValue } from "../filterFields";
import {
  cardReadings,
  oldFirstBuyersText,
  countCutFor,
  ageNow,
  atAlertNote,
  newestStats,
  laterScanText,
  nowReading,
  nowReadingAge,
  recordedPeakOf,
  scanAge,
  sniperReading,
  sniperTileMark,
  sniperTileTitle,
  walletCountText,
} from "./AlertCard";

/** The card's alert time, and a moment after and before it. */
const ALERTED = "2026-10-16T12:00:00.000Z";
const AFTER = "2026-10-16T12:30:00.000Z";
const BEFORE = "2026-10-16T11:20:00.000Z";

/** Just the fields recordedPeakOf reads. */
function card(over: {
  kind: Card["kind"];
  alertMcap: number;
  peakReturnPct?: number | null;
  curated?: {
    peakPct?: number | null;
    peakMcapUsd?: number | null;
    peakAt?: string | null;
    runPeak?: number | null;
  } | null;
}): Card {
  const c = over.curated;
  return {
    kind: over.kind,
    matchedAt: ALERTED,
    snapshot: { marketCapUsd: over.alertMcap },
    peakReturnPct: over.peakReturnPct ?? null,
    curated: c
      ? {
          peakPct: c.peakPct,
          ...(c.peakMcapUsd !== undefined
            ? { peakMcapUsd: c.peakMcapUsd, peakAt: c.peakAt !== undefined ? c.peakAt : AFTER }
            : {}),
          outcome: { peak24hReturnPct: c.runPeak ?? null, runPeakMinutes: 12 },
        }
      : null,
  } as unknown as Card;
}

describe("recordedPeakOf", () => {
  it("reads a call with no grading data (outcome null) without throwing", () => {
    const c = card({ kind: "curated", alertMcap: 20_000, peakReturnPct: 50, curated: {} });
    (c.curated as unknown as { outcome: null }).outcome = null;
    expect(recordedPeakOf(c).pct).toBe(50);
  });

  it("re-bases a folded call's high onto the filter alert's market cap", () => {
    // Called at $20k, caught by the filter at $60k, topped out at $200k.
    const peak = recordedPeakOf(
      card({
        kind: "match",
        alertMcap: 60_000,
        peakReturnPct: (200_000 / 60_000 - 1) * 100,
        curated: { peakPct: 900, peakMcapUsd: 200_000, runPeak: 40 },
      }),
    );
    expect(peak.pct).toBeCloseTo(233.33, 1);
    expect(peak.isRunPeak).toBe(false);
  });

  it("leaves out a folded call's peak from before the filter alert", () => {
    // Called at $10k, peaked at $60k at 11:20, caught by the filter at $30k at 12:00 and never higher.
    const peak = recordedPeakOf(
      card({
        kind: "match",
        alertMcap: 30_000,
        peakReturnPct: null,
        curated: { peakPct: 500, peakMcapUsd: 60_000, peakAt: BEFORE, runPeak: 500 },
      }),
    );
    expect(peak).toEqual({ pct: null, isRunPeak: false });

    // Its time unknown: not re-based either.
    const unknown = recordedPeakOf(
      card({
        kind: "match",
        alertMcap: 30_000,
        peakReturnPct: 10,
        curated: { peakPct: 500, peakMcapUsd: 60_000, peakAt: null, runPeak: 500 },
      }),
    );
    expect(unknown.pct).toBe(10);
  });

  it("does not time a folded call's peak by the call's run peak minutes", () => {
    const peak = recordedPeakOf(
      card({
        kind: "match",
        alertMcap: 60_000,
        peakReturnPct: 10,
        curated: { peakPct: 900, peakMcapUsd: 200_000, runPeak: 900 },
      }),
    );
    expect(peak.isRunPeak).toBe(false);
  });

  it("keeps the call's percentage from an older API build", () => {
    const peak = recordedPeakOf(
      card({ kind: "match", alertMcap: 60_000, peakReturnPct: 50, curated: { peakPct: 900, runPeak: 900 } }),
    );
    expect(peak.pct).toBe(900);
  });

  it("times the Peak by the run peak only when the run peak is the Peak shown", () => {
    const run = recordedPeakOf(
      card({ kind: "curated", alertMcap: 100_000, peakReturnPct: 40, curated: { peakPct: 40, runPeak: 40 } }),
    );
    expect(run).toEqual({ pct: 40, isRunPeak: true });

    // The market-cap high came hours after the 30-minute watch ended.
    const later = recordedPeakOf(
      card({
        kind: "curated",
        alertMcap: 100_000,
        peakReturnPct: 400,
        curated: { peakPct: 400, runPeak: 40 },
      }),
    );
    expect(later).toEqual({ pct: 400, isRunPeak: false });
  });

  it("keeps a call's Peak the API left empty, not its watcher run peak", () => {
    // The candles show the coin never closed above the call; the watcher saw +32% after a rug.
    const peak = recordedPeakOf(
      card({
        kind: "curated",
        alertMcap: 100_000,
        peakReturnPct: null,
        curated: { peakPct: null, runPeak: 32 },
      }),
    );
    expect(peak).toEqual({ pct: null, isRunPeak: false });
  });

  it("does not time the filter alert's ATH by the call's run peak", () => {
    const peak = recordedPeakOf(
      card({
        kind: "match",
        alertMcap: 100_000,
        peakReturnPct: 300,
        curated: { peakPct: 40, peakMcapUsd: 140_000, runPeak: 40 },
      }),
    );
    expect(peak).toEqual({ pct: 300, isRunPeak: false });
  });
});

describe("nowReading", () => {
  const called = "2026-10-12T12:00:00.000Z";
  const at = (secondsAfter: number) => new Date(Date.parse(called) + secondsAfter * 1000).toISOString();
  const call = (kind: Card["kind"], readAt: string | null) =>
    ({
      kind,
      currentMarketCapUsd: 47_500,
      currentMarketCapAt: readAt,
      curated: { alertedAt: called },
    }) as unknown as Card;

  it("leaves out a model call's readings from its first minute", () => {
    // CASINO: called at $11.4K, but the scan reading 14 s later still showed $47.5K.
    expect(nowReading(call("curated", at(14)))).toBeNull();
    expect(nowReading(call("curated", at(-5)))).toBeNull();
    expect(nowReading(call("curated", at(60)))).toBe(47_500);
  });

  it("shows every reading on a filter alert priced from its snapshot, which lags the same way", () => {
    expect(nowReading(call("match", at(14)))).toBe(47_500);
  });

  it("leaves out the first minute on a filter alert priced from a fresh quote", () => {
    const match = { ...call("match", at(14)), matchedAt: called, alertMcapUsd: 11_400 } as Card;
    expect(nowReading(match)).toBeNull();
    expect(nowReading({ ...match, currentMarketCapAt: at(75) })).toBe(47_500);
  });

  it("shows the reading when it has no time (older API builds)", () => {
    expect(nowReading(call("curated", null))).toBe(47_500);
  });

  it("shows a curve-priced reading from the first second: the curve is the market to the block", () => {
    expect(nowReading({ ...call("curated", at(5)), currentMarketCapSource: "curve" })).toBe(47_500);
  });
});

describe("reading ages", () => {
  const now = Date.parse("2026-10-16T12:30:00.000Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("labels a Now reading once the market it shows is two minutes old", () => {
    // DexScreener runs ~45 s behind when fetched; a curve reading is the market to the block.
    expect(nowReadingAge({ currentMarketCapAt: ago(60_000) }, 1, now)).toBeNull();
    expect(nowReadingAge({ currentMarketCapAt: ago(90_000) }, 1, now)).toBe("2m");
    expect(
      nowReadingAge({ currentMarketCapAt: ago(90_000), currentMarketCapSource: "curve" }, 1, now),
    ).toBeNull();
    expect(nowReadingAge({ currentMarketCapAt: ago(3 * 60_000) }, 1, now)).toBe("4m");
    expect(nowReadingAge({ currentMarketCapAt: ago(3 * 60_000) }, null, now)).toBeNull();
    expect(nowReadingAge({ currentMarketCapAt: null }, 1, now)).toBeNull();
  });

  it("says how old the newest scan is", () => {
    expect(
      laterScanText({ latestSnapshot: { takenAt: ago(12 * 60_000) } as Card["latestSnapshot"] }, now),
    ).toBe("from a scan 12m ago");
    expect(laterScanText({ latestSnapshot: null }, now)).toBe("from a scan after the alert");
  });

  it("ages the coin from its alert snapshot to now", () => {
    expect(ageNow({ ageMinutes: 4, takenAt: ago(3 * 3_600_000) }, now)).toBe(184);
    expect(ageNow({ ageMinutes: null, takenAt: ago(0) }, now)).toBeNull();
  });
});

describe("holder counts", () => {
  it("shows a top-10 check as N of the wallets the list held", () => {
    expect(walletCountText(40, 10)).toBe("4/10");
    expect(walletCountText(77.78, 9)).toBe("7/9");
    expect(walletCountText(30, null)).toBe("3/10");
    expect(walletCountText(null, 10)).toBeNull();
  });

  it("cuts a count over fewer than 25 holders at the same share, as the screen does", () => {
    expect(countCutFor(20, 25)).toBe(20);
    expect(countCutFor(20, 19)).toBe(16);
    expect(countCutFor(21, 20)).toBe(17);
    expect(countCutFor(21, null)).toBe(21);
  });

  it("reads snipers over the top 25, else the top-10 share as a count", () => {
    expect(
      sniperReading(
        {
          sniperTopHolderCount: 6,
          sniperTopHoldersChecked: 25,
          sniperTop10WalletPct: 40,
          top10WalletsChecked: 10,
        },
        true,
      ),
    ).toMatchObject({ count: 6, of: 25, top25: true, top10Pct: 40 });
    expect(sniperReading({ sniperTop10WalletPct: 30, top10WalletsChecked: 10 }, false)).toMatchObject({
      count: 3,
      of: 10,
      top25: false,
    });
    expect(sniperReading({}, true)).toBeNull();
  });

  it("does not mark a top-25 sniper count risky from the top-10 cut", () => {
    const top25 = sniperReading(
      {
        sniperTopHolderCount: 6,
        sniperTopHoldersChecked: 25,
        sniperTop10WalletPct: 80,
        top10WalletsChecked: 10,
      },
      true,
    );
    expect(sniperTileMark(top25)).toEqual({ risky: false, share: null });
    expect(sniperTileTitle(top25, "later")).not.toContain("(top 10 only on this scan)");
    const only10 = sniperReading({ sniperTop10WalletPct: 80, top10WalletsChecked: 10 }, false);
    expect(sniperTileMark(only10)).toEqual({ risky: true, share: 80 });
    expect(sniperTileTitle(only10, "later")).toContain("(top 10 only on this scan)");
    expect(
      sniperTileMark(sniperReading({ sniperTop10WalletPct: 30, top10WalletsChecked: 10 }, true)),
    ).toEqual({
      risky: false,
      share: 30,
    });
  });

  it("reads Fresh over the top 25 where the scan counted it, else the top 10", () => {
    const readings = (snapshot: object, latest: object | null = null) =>
      cardReadings({ snapshot, latestSnapshot: latest, token: {} } as unknown as Card);
    const r = readings({
      freshTop10WalletPct: 80,
      top10WalletsChecked: 10,
      freshTopHolderCount: 6,
      freshTopHoldersChecked: 25,
    });
    expect(walletCountText(r.freshPct, r.freshOf)).toBe("6/25");
    expect(r.freshAtAlert).not.toBeNull();
    const old = readings({ freshTop10WalletPct: 30, top10WalletsChecked: 10 });
    expect(walletCountText(old.freshPct, old.freshOf)).toBe("3/10");
    const later = readings({}, { freshTopHolderCount: 18, freshTopHoldersChecked: 25 });
    expect(walletCountText(later.freshPct, later.freshOf)).toBe("18/25");
    expect(later.freshAtAlert).toBeNull();
  });

  it("carries the older first-buyers count, labelled, where no 0.1% count was recorded", () => {
    const readings = (snapshot: object, latest: object | null = null) =>
      cardReadings({ snapshot, latestSnapshot: latest, token: {} } as unknown as Card);
    const old = readings({ firstBuyersHolding: 14, firstBuyersSeen: 25 });
    expect(old).toMatchObject({ firstHolding: null, firstHoldingOld: 14, firstSeenOld: 25 });
    expect(oldFirstBuyersText(14, 25)).toMatch(/^\* Older count: 14 of the first 25 buyers/);
    const both = readings({ firstBuyersHolding: 14, firstBuyersSeen: 25, firstBuyersHoldingCut: 4 });
    expect(both).toMatchObject({ firstHolding: 4, firstSeen: 25 });
  });

  it("shows a saved share as the count it lets through", () => {
    expect(shownValue({ scale: 4 }, 50)).toBe(12);
    expect(shownValue({ scale: 4 }, 72)).toBe(18);
    expect(shownValue({ scale: 10 }, 40)).toBe(4);
    expect(shownValue({ scale: 10 }, 45)).toBe(4);
    expect(shownValue({}, 45)).toBe(45);
  });
});

describe("tiles read the newest scan (user decision 2026-10-17)", () => {
  const alert = {
    takenAt: "2026-10-16T12:00:00.000Z",
    score: 80,
    top10HolderPct: 30,
    holderCount: 100,
    largestHolderPct: 5,
    cexFundedPct: 10,
  };
  const newest = {
    takenAt: "2026-10-16T13:00:00.000Z",
    score: 60,
    top10HolderPct: null,
    holderCount: 250,
    largestHolderPct: 9,
    cexFundedPct: null,
  };
  const c = { snapshot: alert, latestSnapshot: newest, token: {} } as unknown as Card;

  it("shows the newest scan's stats, falling back to the alert's where it has none", () => {
    const t = newestStats(c);
    expect(t).toMatchObject({
      fromLatest: true,
      score: 60,
      holders: 250,
      top10Pct: 30,
      top10FromLatest: false,
    });
    expect(newestStats({ ...c, latestSnapshot: { ...alert } as Card["latestSnapshot"] }).fromLatest).toBe(
      false,
    );
  });

  it("reads wallet tiles newest first on the card, alert first in the token view", () => {
    expect(cardReadings(c, "newest")).toMatchObject({
      largestPct: 9,
      largestAtAlert: false,
      cexPct: 10,
      cexAtAlert: true,
    });
    expect(cardReadings(c)).toMatchObject({ largestPct: 5, largestAtAlert: true });
  });

  it("notes the alert's value only when it differs", () => {
    expect(atAlertNote("30%", "42%")).toBe(" (at the alert: 30%)");
    expect(atAlertNote("30%", "30%")).toBe("");
    expect(atAlertNote(null, "30%")).toBe("");
  });
});

describe("scanAge", () => {
  const at = (iso: string) => ({ takenAt: iso }) as Card["snapshot"];
  const now = Date.parse("2026-10-16T13:00:00.000Z");

  it("is null while the newest scan is under five minutes old", () => {
    expect(scanAge({ snapshot: at(BEFORE), latestSnapshot: at("2026-10-16T12:56:00.000Z") }, now)).toBeNull();
  });

  it("labels the newest scan's age once it is five minutes old or more", () => {
    expect(scanAge({ snapshot: at(BEFORE), latestSnapshot: at(AFTER) }, now)).toBe("30m");
    expect(scanAge({ snapshot: at(ALERTED), latestSnapshot: null }, now)).toBe("1.0h");
  });
});
