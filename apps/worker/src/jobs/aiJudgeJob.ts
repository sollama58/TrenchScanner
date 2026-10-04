import { prisma, createLogger, type Env } from "@trenchscanner/core";
import { anthropicConfigured } from "../ai/client.js";
import { pollReplayRuns } from "../ai/replay.js";
import { maybeEvolvePlaybook, settleEvolutionRun } from "../ai/playbook.js";
import { refitAiBlend } from "../ai/blend.js";

const logger = createLogger("ai-judge");

/**
 * The AI judge's housekeeping, every AI_JUDGE_INTERVAL_MINUTES: collect finished replay batches
 * and settle playbook rounds, start the next round when one is due (ai/playbook.ts), and refit
 * the learned blend on the curator-training cadence (ai/blend.ts). Does nothing without
 * ANTHROPIC_API_KEY or with the reviewer off - the blend included, since it only matters to a
 * reviewer that runs.
 */
export async function runAiJudgeJob(env: Env): Promise<Record<string, string | number | boolean>> {
  if (!anthropicConfigured(env) || env.AI_REVIEW_MODE === "off") return { skipped: "reviewer off" };

  const meta: Record<string, string | number | boolean> = {};
  const scored = await pollReplayRuns(env);
  meta.replaysScored = scored.length;
  for (const run of scored) {
    if (run.purpose === "evolution") meta.evolution = await settleEvolutionRun(run, env);
  }

  try {
    meta.playbook = await maybeEvolvePlaybook(env);
  } catch (err) {
    logger.warn("playbook evolution step failed", { error: String(err) });
    meta.playbook = "error";
  }

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
