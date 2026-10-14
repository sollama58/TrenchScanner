import { describe, expect, it } from "vitest";
import type { Card } from "../api";
import { shownValue } from "../filterFields";
import {
  cardReadings,
  countCutFor,
  nowReading,
  recordedPeakOf,
  sniperReading,
  walletCountText,
} from "./AlertCard";

/** Just the fields recordedPeakOf reads. */
function card(over: {
  kind: Card["kind"];
  alertMcap: number;
  peakReturnPct?: number | null;
  curated?: { peakPct?: number | null; peakMcapUsd?: number | null; runPeak?: number | null } | null;
}): Card {
  const c = over.curated;
  return {
    kind: over.kind,
    snapshot: { marketCapUsd: over.alertMcap },
    peakReturnPct: over.peakReturnPct ?? null,
    curated: c
      ? {
          peakPct: c.peakPct,
          ...(c.peakMcapUsd !== undefined ? { peakMcapUsd: c.peakMcapUsd } : {}),
          outcome: { peak24hReturnPct: c.runPeak ?? null, runPeakMinutes: 12 },
        }
      : null,
  } as unknown as Card;
}

describe("recordedPeakOf", () => {
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

  it("shows a saved share as the count it lets through", () => {
    expect(shownValue({ scale: 4 }, 50)).toBe(12);
    expect(shownValue({ scale: 4 }, 72)).toBe(18);
    expect(shownValue({ scale: 10 }, 40)).toBe(4);
    expect(shownValue({ scale: 10 }, 45)).toBe(4);
    expect(shownValue({}, 45)).toBe(45);
  });
});
