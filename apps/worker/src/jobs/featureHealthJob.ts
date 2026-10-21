import {
  prisma,
  createLogger,
  featureHealthReport,
  CANDIDATE_FEATURE_NAMES,
  suggestPromotions,
  promotionSummary,
  type Env,
} from "@trenchscanner/core";

const logger = createLogger("feature-health");

const WINDOW_DAYS = 7;
const MAX_ROWS = 20_000;

/**
 * Weekly snapshot of per-input health on recent decision rows. Runs on the trainer process;
 * results land in the feature-health heartbeat for the admin pipeline watch.
 */
export async function runFeatureHealthJob(_env: Env): Promise<{ rows: number; suggestions: number }> {
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000);
  const rows = await prisma.candidateOutcome.findMany({
    where: {
      sampleKind: "event",
      anchorAt: { gte: since },
    },
    select: { features: true, labelValue: true, anchorAt: true },
    orderBy: { anchorAt: "desc" },
    take: MAX_ROWS,
  });
  const trainingRows = rows.map((r) => ({
    features: r.features as Record<string, number | null | undefined>,
    labelValue: r.labelValue,
    anchorAt: r.anchorAt,
  }));
  const report = featureHealthReport(trainingRows, CANDIDATE_FEATURE_NAMES);
  const suggestions = suggestPromotions(trainingRows);
  const summary = promotionSummary(suggestions);
  logger.info("feature health snapshot", {
    rows: report.rows,
    baseWinRatePct: report.baseWinRatePct,
    suggestions: suggestions.length,
    promote: summary,
    retiredHighNull: report.features
      .filter((f) => f.retired && (f.recentNullRatePct ?? 100) > 50)
      .slice(0, 8)
      .map((f) => f.feature),
  });
  return { rows: report.rows, suggestions: suggestions.length };
}
