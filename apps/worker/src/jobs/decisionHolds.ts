/**
 * What held a ready coin back from a decision moment, counted where the scan already makes each
 * hold (processCandidate in scanJob.ts) and reported on the scan heartbeat: per cycle, and summed
 * since this process booted. Measurement only (audit 2026-10-14, lane 2 M2): the export can't say
 * which of these held a runner that was decided late or never.
 *
 * - `preGate5m`: the event pre-gate failed on its "last five minutes not falling" test alone.
 * - `walletChecks`: the wallet checks the curator needs are not all known yet (walletChecksKnown,
 *   which has no time bound).
 * - `sniperWait`: waiting on the top-10 snipers share (sniperShareReady).
 * - `linkedWait`: waiting on the Linked and CEX-funded counts (linkedListReady).
 *
 * A coin counts once per reason per cycle it is held, so a coin held for three cycles counts
 * three times, and one waiting on both the snipers and the linked list counts under both. A hold
 * is counted whether or not the coin's decision window was still open (an event already spent in
 * CANDIDATE_EVENT_SPACING_MINUTES is held all the same); read the counts against the cycle's
 * banked event rows (samplesBanked) for scale.
 */
export const DECISION_HOLD_REASONS = ["preGate5m", "walletChecks", "sniperWait", "linkedWait"] as const;
export type DecisionHoldReason = (typeof DECISION_HOLD_REASONS)[number];

function zeroes(): Record<DecisionHoldReason, number> {
  return Object.fromEntries(DECISION_HOLD_REASONS.map((r) => [r, 0])) as Record<DecisionHoldReason, number>;
}

let sinceRead = zeroes();
const sinceBoot = zeroes();

export function noteDecisionHold(reason: DecisionHoldReason): void {
  sinceRead[reason] += 1;
  sinceBoot[reason] += 1;
}

/** The holds since the last read (the cycle's), and the running totals since boot. */
export function takeDecisionHolds(): {
  cycle: Record<DecisionHoldReason, number>;
  sinceBoot: Record<DecisionHoldReason, number>;
} {
  const cycle = sinceRead;
  sinceRead = zeroes();
  return { cycle, sinceBoot: { ...sinceBoot } };
}

/** Test hook. */
export function resetDecisionHolds(): void {
  sinceRead = zeroes();
  for (const r of DECISION_HOLD_REASONS) sinceBoot[r] = 0;
}
