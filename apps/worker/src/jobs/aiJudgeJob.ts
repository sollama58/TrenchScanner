import { prisma, createLogger, aiReviewerState, type Env } from "@trenchscanner/core";
import { anthropicConfigured } from "../ai/client.js";
import { pollReplayRuns } from "../ai/replay.js";
import { maybeEvolvePlaybook, settleEvolutionRun, unsettledEvolutionRuns } from "../ai/playbook.js";
import { refitAiBlend } from "../ai/blend.js";

const logger = createLogger("ai-judge");

/**
 * The AI judge's housekeeping, every AI_JUDGE_INTERVAL_MINUTES: collect finished replay batches
 * and settle playbook rounds, start the next round when one is due (ai/playbook.ts), and refit
 * the learned blend on the curator-training cadence (ai/blend.ts). Does nothing without
 * ANTHROPIC_API_KEY, with the reviewer off, or with the Admin panel's AI reviewer switch off -
 * the blend included, since it only matters to a reviewer that runs. With the switch on
 * "admins" (testing), a fresh playbook still gets its baseline replay but no round runs that
 * could promote another, so the test's shadow record is one fixed prompt's.
 */
export async function runAiJudgeJob(
  env: Env,
  signal?: AbortSignal,
): Promise<Record<string, string | number | boolean>> {
  if (!anthropicConfigured(env) || env.AI_REVIEW_MODE === "off") return { skipped: "reviewer off" };
  const state = await aiReviewerState();
  if (state === "off") return { skipped: "switched off" };
  // The lock's connection died and another process holds the job (jobLock.ts). Stop before
  // ingesting or spending; the scheduler writes no heartbeat for the stop.
  if (signal?.aborted) return { stopped: "lock lost" };

  const meta: Record<string, string | number | boolean> = {};
  const scored = await pollReplayRuns(env, signal);
  meta.replaysScored = scored.length;
  if (signal?.aborted) return { ...meta, stopped: "lock lost" };
  // pollReplayRuns marks a run scored before it is settled here, so a settle that failed (or a
  // pass that died in between) used to leave that round's candidates "candidate" for good, the
  // run never picked up again. Every pass also settles any scored round still left like that -
  // which includes the ones just scored - each on its own, so one failure doesn't stop the rest.
  for (const run of await unsettledEvolutionRuns()) {
    if (signal?.aborted) return { ...meta, stopped: "lock lost" };
    try {
      meta.evolution = await settleEvolutionRun(run, env);
    } catch (err) {
      logger.error("could not settle a playbook evolution round - retrying next pass", {
        run: run.id,
        error: String(err),
      });
      meta.evolution = "error";
    }
  }

  if (signal?.aborted) return { ...meta, stopped: "lock lost" };
  try {
    meta.playbook = await maybeEvolvePlaybook(env, Date.now(), { baselineOnly: state !== "live" });
  } catch (err) {
    logger.warn("playbook evolution step failed", { error: String(err) });
    meta.playbook = "error";
  }

  if (signal?.aborted) return { ...meta, stopped: "lock lost" };
  const newestBlend = await prisma.aiBlendModel.findFirst({
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (
    !newestBlend ||
    Date.now() - newestBlend.createdAt.getTime() >= env.CURATOR_TRAINING_INTERVAL_HOURS * 3_600_000
  ) {
    const fit = await refitAiBlend(env);
    if (fit) {
      meta.blendRows = fit.rows;
      meta.blendUsable = fit.usable;
    }
  }
  return meta;
}
