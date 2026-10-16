import { prisma } from "./db.js";
import type { HeartbeatJob } from "./heartbeat.js";

/**
 * The scheduled jobs an admin may start early from Admin > Worker ("Run now"), and the ones they
 * may not, with why. One list read by the API (which refuses anything not on it), the worker
 * (which only listens for requests on these) and, through the API, the panel.
 *
 * A job is on it only when an early run is the same as its next scheduled one, a little sooner:
 * it never overlaps itself (the scheduler runs one at a time per process, and the batch jobs hold
 * a cross-process lock - jobLock.ts), it re-does nothing it already did, and it changes nothing a
 * scheduled run wouldn't. `heavy` ones take minutes of CPU or database time, or spend money, and
 * the panel asks before queueing them.
 */
export interface ManualRunJob {
  job: HeartbeatJob;
  /** What a run does, in a line, for the panel. */
  does: string;
  /** Minutes of CPU or database time, or paid calls: the panel confirms first. */
  heavy: boolean;
}

export const MANUAL_RUN_JOBS: readonly ManualRunJob[] = [
  {
    job: "curator-training",
    does: "Retrains and re-examines every curator model (the same as Retrain now).",
    heavy: true,
  },
  {
    job: "outcome-tracking",
    does: "Grades the outcomes of past alerts against DexScreener prices.",
    heavy: true,
  },
  {
    job: "lighthouse-rollup",
    does: "Re-sums the Lighthouse tab's trailing day of history.",
    heavy: true,
  },
  {
    job: "score-weights",
    does: "Refits the composite score's weights; adopted only if they rank better.",
    heavy: true,
  },
  {
    job: "ai-judge",
    does: "Collects AI replay batches, settles playbook rounds, refits the AI blend when due.",
    heavy: true,
  },
  {
    job: "wallet-risk",
    does: "Rebuilds the wallet risk scores from the trade tape.",
    heavy: false,
  },
  {
    job: "kol-side-wallets",
    does: "Rebuilds the Side Wallet Checker's lists from the trade tape.",
    heavy: false,
  },
  {
    job: "kol-wallets",
    does: "Re-reads Solana Tracker's KOL roster.",
    heavy: false,
  },
  {
    job: "champion-refresh",
    does: "Re-chooses the default model from the live leaderboard.",
    heavy: false,
  },
  {
    job: "model-backup",
    does: "Takes the weekly model backup if one is due and copies new ones off-site.",
    heavy: false,
  },
  {
    job: "burn-scan",
    does: "Looks for subscription burns nobody reported and credits them.",
    heavy: false,
  },
];

/** The jobs left off MANUAL_RUN_JOBS, and why - shown under the list so nothing looks forgotten. */
export const MANUAL_RUN_EXCLUDED: Readonly<Partial<Record<HeartbeatJob, string>>> = {
  cleanup:
    "Deletes old rows for good, and its sweeps hold the shared database for up to half an hour. It runs nightly and catches up by itself after a missed night.",
  "pipeline-watch":
    "Can restart the scanner and messages the admins on Telegram. It already checks every minute.",
  "telegram-dispatch": "Sends Telegram messages, and already runs every few seconds and on every new alert.",
  scan: "Already runs every minute, and sooner when a launch enters the band.",
  "fast-match": "Already runs every few seconds.",
  "live-price": "Already runs every minute.",
  "candidate-watch": "Already runs every minute; its cadence is the label resolution.",
  "match-peaks": "Already runs every couple of minutes.",
  "label-regrade": "Already runs every minute until history is re-graded.",
  "trade-tape": "Already runs every minute.",
  "free-access":
    "Deletes accounts for good. It runs every few minutes, an hour after a period ends or is switched off.",
};

/** The entry for `job`, or undefined when it can't be run from the panel. */
export function manualRunJob(job: string): ManualRunJob | undefined {
  return MANUAL_RUN_JOBS.find((j) => j.job === job);
}

/** Whether an admin's "Run now" for `job` is waiting for a run to pick it up. */
export async function manualRunRequested(job: HeartbeatJob): Promise<boolean> {
  return (await prisma.jobRunRequest.count({ where: { job, startedAt: null } })) > 0;
}

/**
 * Marks `job`'s waiting requests started: called as every run begins, early or on schedule, since
 * either one does what the request asked for.
 */
export async function takeManualRunRequests(job: HeartbeatJob, at: Date = new Date()): Promise<number> {
  const { count } = await prisma.jobRunRequest.updateMany({
    where: { job, startedAt: null },
    data: { startedAt: at },
  });
  return count;
}
