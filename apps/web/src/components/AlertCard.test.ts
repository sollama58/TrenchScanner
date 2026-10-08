import { describe, expect, it } from "vitest";
import type { Card } from "../api";
import { recordedPeakOf } from "./AlertCard";

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
