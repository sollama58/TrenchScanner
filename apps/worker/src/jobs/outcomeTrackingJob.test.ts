import { describe, expect, it } from "vitest";
import {
  readOutcomeCheckpoint,
  readRetryTokens,
  reconcileMatchOutcome,
  type MatchOutcomeState,
} from "./outcomeTrackingJob.js";

const NOW = new Date("2026-08-27T05:00:00.000Z");
const PEAKED_AT = new Date("2026-08-01T12:00:00.000Z");

/** A match alerted at $100k that has never been seen above that. */
function pristine(overrides: Partial<MatchOutcomeState> = {}): MatchOutcomeState {
  return {
    alertMcapUsd: 100_000,
    peakMcapUsd: null,
    peakMcapAt: null,
    peakReturnPct: null,
    hitHundredPctAt: null,
    ...overrides,
  };
}

describe("reconcileMatchOutcome", () => {
  it("records a new high above the alert mcap", () => {
    const update = reconcileMatchOutcome(pristine(), 150_000, NOW);
    expect(update).toEqual({ peakMcapUsd: 150_000, peakMcapAt: NOW, peakReturnPct: 50 });
  });

  it("leaves a match that has never traded above its alert mcap completely alone", () => {
    // peakMcapUsd stays null rather than being pinned to the alert mcap, and peakReturnPct stays
    // null with it - the schema documents the second as derived from the first, so writing "0%"
    // against a null peak would make that pair incoherent.
    expect(reconcileMatchOutcome(pristine(), 80_000, NOW)).toBeNull();
    expect(reconcileMatchOutcome(pristine(), 100_000, NOW)).toBeNull();
  });

  it("keeps the recorded peak when the current mcap is below it", () => {
    const state = pristine({
      peakMcapUsd: 300_000,
      peakMcapAt: PEAKED_AT,
      peakReturnPct: 200,
      hitHundredPctAt: PEAKED_AT,
    });
    expect(reconcileMatchOutcome(state, 120_000, NOW)).toBeNull();
  });

  it("stamps eligibility off a peak recorded on an earlier run, with no new high", () => {
    // The regression this whole function exists for. A match that 3x'd weeks ago and has been
    // sliding ever since used to be unreachable: hitHundredPctAt was only written inside the
    // "current > recorded peak" branch, so a token that already had its run could never be
    // stamped, and the Leaderboard - whose entire population is tokens that already ran - stayed
    // permanently empty.
    const state = pristine({ peakMcapUsd: 300_000, peakMcapAt: PEAKED_AT, peakReturnPct: 200 });
    expect(reconcileMatchOutcome(state, 120_000, NOW)).toEqual({ hitHundredPctAt: PEAKED_AT });
  });

  it("backfills peakReturnPct for a peak recorded before that column existed", () => {
    const state = pristine({ peakMcapUsd: 250_000, peakMcapAt: PEAKED_AT });
    expect(reconcileMatchOutcome(state, undefined, NOW)).toEqual({
      peakReturnPct: 150,
      hitHundredPctAt: PEAKED_AT,
    });
  });

  it("works with no live data at all, off the recorded peak alone", () => {
    // What the repair pass passes: DexScreener is never called for matches this old.
    const state = pristine({ peakMcapUsd: 500_000, peakMcapAt: PEAKED_AT });
    const update = reconcileMatchOutcome(state, undefined, NOW);
    expect(update).toEqual({ peakReturnPct: 400, hitHundredPctAt: PEAKED_AT });
  });

  it("dates a retroactive stamp to when the peak was recorded, not to this run", () => {
    const state = pristine({ peakMcapUsd: 220_000, peakMcapAt: PEAKED_AT, peakReturnPct: 120 });
    expect(reconcileMatchOutcome(state, undefined, NOW)?.hitHundredPctAt).toBe(PEAKED_AT);
  });

  it("dates the stamp to now when this run is the one that crossed the threshold", () => {
    const state = pristine({ peakMcapUsd: 150_000, peakMcapAt: PEAKED_AT, peakReturnPct: 50 });
    const update = reconcileMatchOutcome(state, 210_000, NOW);
    expect(update?.peakMcapUsd).toBe(210_000);
    expect(update?.peakMcapAt).toBe(NOW);
    expect(update?.peakReturnPct).toBeCloseTo(110, 9);
    expect(update?.hitHundredPctAt).toBe(NOW);
  });

  it("never re-stamps a match that is already eligible", () => {
    const state = pristine({
      peakMcapUsd: 300_000,
      peakMcapAt: PEAKED_AT,
      peakReturnPct: 200,
      hitHundredPctAt: PEAKED_AT,
    });
    const update = reconcileMatchOutcome(state, 900_000, NOW);
    expect(update).toEqual({ peakMcapUsd: 900_000, peakMcapAt: NOW, peakReturnPct: 800 });
    expect(update).not.toHaveProperty("hitHundredPctAt");
  });

  it("treats exactly +100% as qualifying", () => {
    const state = pristine({ peakMcapUsd: 200_000, peakMcapAt: PEAKED_AT, peakReturnPct: 100 });
    expect(reconcileMatchOutcome(state, undefined, NOW)).toEqual({ hitHundredPctAt: PEAKED_AT });
  });

  it("leaves a +99% match ineligible", () => {
    const state = pristine({ peakMcapUsd: 199_000, peakMcapAt: PEAKED_AT, peakReturnPct: 99 });
    expect(reconcileMatchOutcome(state, undefined, NOW)).toBeNull();
  });

  it("produces no write for an already-correct row", () => {
    // Matters because this runs nightly over every recent match - a row that needs nothing must
    // cost nothing, or the job turns into a full-table rewrite every night.
    const state = pristine({
      peakMcapUsd: 300_000,
      peakMcapAt: PEAKED_AT,
      peakReturnPct: 200,
      hitHundredPctAt: PEAKED_AT,
    });
    expect(reconcileMatchOutcome(state, 300_000, NOW)).toBeNull();
    expect(reconcileMatchOutcome(state, undefined, NOW)).toBeNull();
  });

  it("refuses to divide by a zero alert mcap", () => {
    const state = pristine({ alertMcapUsd: 0, peakMcapUsd: 50_000, peakMcapAt: PEAKED_AT });
    // The new high is still worth recording; the percentage isn't computable, so it stays null and
    // the match never becomes eligible rather than becoming Infinity% and topping the board.
    expect(reconcileMatchOutcome(state, 90_000, NOW)).toEqual({ peakMcapUsd: 90_000, peakMcapAt: NOW });
  });

  it("falls back to now when a recorded peak has no timestamp", () => {
    const state = pristine({ peakMcapUsd: 300_000, peakMcapAt: null, peakReturnPct: 200 });
    expect(reconcileMatchOutcome(state, undefined, NOW)).toEqual({ hitHundredPctAt: NOW });
  });
});

describe("readOutcomeCheckpoint", () => {
  const saved = {
    runStartedAt: "2026-10-18T05:36:00.000Z",
    snapshotsSince: "2026-10-16T05:56:00.000Z",
    stage: "live",
    after: "Mint123",
    fromSnapshots: 4,
    fromLivePings: 1,
    failedBatches: 0,
    callPeaksRaised: 2,
    matchesChecked: 900,
    peaksUpdated: 7,
    missingLiveData: 30,
    resumes: 1,
  };
  const at = (iso: string) => Date.parse(iso);

  it("resumes a run a deploy cut short", () => {
    // What 2026-10-18 needed: three deploys in an hour each killed the run, and each catch-up
    // started from the first token again.
    const meta = { runningSince: "2026-10-18T05:36:00.000Z", outcomeResume: saved };
    expect(readOutcomeCheckpoint(meta, at("2026-10-18T06:06:00.000Z"))).toEqual(saved);
  });

  it("starts over when the saved run belongs to a slot long gone", () => {
    expect(readOutcomeCheckpoint({ outcomeResume: saved }, at("2026-10-18T18:00:00.000Z"))).toBeNull();
  });

  it("starts over with nothing saved, or a meta it can't read", () => {
    const now = at("2026-10-18T06:06:00.000Z");
    expect(readOutcomeCheckpoint(null, now)).toBeNull();
    expect(readOutcomeCheckpoint({ durationMs: 1000, dailyAtHourUtc: 5 }, now)).toBeNull();
    expect(readOutcomeCheckpoint({ outcomeResume: { ...saved, stage: "nope" } }, now)).toBeNull();
    expect(readOutcomeCheckpoint({ outcomeResume: { ...saved, runStartedAt: "garbage" } }, now)).toBeNull();
  });

  it("keeps a sweep with no snapshot bound unbounded, and fills missing counts with zero", () => {
    const { matchesChecked: _m, ...rest } = saved;
    void _m;
    const read = readOutcomeCheckpoint(
      { outcomeResume: { ...rest, snapshotsSince: null, stage: "match-peaks" } },
      at("2026-10-18T06:06:00.000Z"),
    );
    expect(read?.snapshotsSince).toBeNull();
    expect(read?.matchesChecked).toBe(0);
  });
});

describe("readRetryTokens", () => {
  it("reads the tokens a run could not sweep, with the bound they missed", () => {
    expect(
      readRetryTokens({ retryTokens: "a,b", retrySince: "2026-10-17T04:00:00.000Z", retryNights: 2 }),
    ).toEqual({ ids: ["a", "b"], since: new Date("2026-10-17T04:00:00.000Z"), nights: 2 });
    // No bound: the whole history; no count: the first night.
    expect(readRetryTokens({ retryTokens: "a", retrySince: null })).toEqual({
      ids: ["a"],
      since: null,
      nights: 1,
    });
  });

  it("is null when the last run left nothing to retry", () => {
    expect(readRetryTokens(null)).toBeNull();
    expect(readRetryTokens({ matchesChecked: 4 })).toBeNull();
    expect(readRetryTokens({ retryTokens: "" })).toBeNull();
  });
});
