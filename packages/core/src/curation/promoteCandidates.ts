import { featureHealthReport } from "./featureReport.js";
import { RETIRED_LEARNER_INPUTS } from "./features.js";

export interface PromoteCandidate {
  feature: string;
  reason: string;
}

const MIN_PRESENT = 2000;
const MIN_TOP_LIFT = 1.15;
const MAX_RECENT_NULL = 15;

/**
 * Inputs still in RETIRED_LEARNER_INPUTS that look ready to promote: enough present rows, low
 * recent null rate, and decile lift above the base rate.
 */
export function suggestPromotions(
  rows: readonly {
    features: Record<string, number | null | undefined>;
    labelValue: number;
    anchorAt?: Date;
  }[],
): PromoteCandidate[] {
  const report = featureHealthReport(rows);
  const out: PromoteCandidate[] = [];
  for (const h of report.features) {
    if (!h.retired) continue;
    if (h.present < MIN_PRESENT) continue;
    if (h.recentNullRatePct != null && h.recentNullRatePct > MAX_RECENT_NULL) continue;
    if (h.topDecileLift != null && h.topDecileLift >= MIN_TOP_LIFT) {
      out.push({ feature: h.feature, reason: `topDecileLift=${h.topDecileLift}` });
    } else if (h.bottomDecileLift != null && h.bottomDecileLift >= MIN_TOP_LIFT) {
      out.push({ feature: h.feature, reason: `bottomDecileLift=${h.bottomDecileLift}` });
    }
  }
  return out.sort((a, b) => a.feature.localeCompare(b.feature));
}

/** Share of rows graded under the fresh-quote label rule (rule 4+). */
export function labelRuleMix(
  rows: readonly { labelRule?: number; sampleKind?: string }[],
  opts: { decisionOnly?: boolean } = {},
): { total: number; rule4Share: number; rule3Share: number } {
  const FRESH_RULE = 4;
  let set = rows;
  if (opts.decisionOnly) {
    set = rows.filter((r) => r.sampleKind === undefined || r.sampleKind === "event");
  }
  const total = set.length;
  if (total === 0) return { total: 0, rule4Share: 0, rule3Share: 0 };
  let rule4 = 0;
  let rule3 = 0;
  for (const r of set) {
    const rule = r.labelRule ?? FRESH_RULE;
    if (rule >= FRESH_RULE) rule4 += 1;
    else if (rule === 3) rule3 += 1;
  }
  return {
    total,
    rule4Share: rule4 / total,
    rule3Share: rule3 / total,
  };
}

export function promotionSummary(suggestions: readonly PromoteCandidate[]): string | null {
  if (suggestions.length === 0) return null;
  const names = suggestions.slice(0, 12).map((s) => s.feature);
  const more = suggestions.length > names.length ? ` (+${suggestions.length - names.length} more)` : "";
  return `promote candidates: ${names.join(", ")}${more}`;
}

/** True when a name is still watch-only. */
export function isRetiredLearnerInput(feature: string): boolean {
  return (RETIRED_LEARNER_INPUTS as ReadonlySet<string>).has(feature);
}
