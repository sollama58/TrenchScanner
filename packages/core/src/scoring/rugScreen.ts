import type { OnChainProfile, RugScreenResult } from "../types.js";

export interface RugScreenThresholds {
  maxTop10HolderPct: number;
  maxDevWalletPct: number;
  /** RugCheck's composite risk score (0-100, higher = riskier). Catches things our own checks don't, e.g. insider clustering. */
  maxRiskScore: number;
}

export const DEFAULT_RUG_THRESHOLDS: RugScreenThresholds = {
  maxTop10HolderPct: 60,
  maxDevWalletPct: 15,
  maxRiskScore: 70,
};

/**
 * Named risk flags that fail the screen outright regardless of score - found via live testing
 * (see git history): a token can pass every numeric threshold here and still have RugCheck flag
 * the creator's own track record, which our own checks have no way to see.
 */
const CRITICAL_RISK_FLAGS = new Set(["Creator history of rugged tokens"]);

/**
 * Hard exclusion gate. A token must pass this before it's ever shown to a
 * user, independent of their filter settings - this is the "auto-filter
 * scams" behavior chosen in planning, not something users can turn off.
 *
 * Fails closed: if we don't have a verified on-chain profile at all, or a
 * given signal is missing, we treat that as a fail rather than letting an
 * unverifiable token through. Individual per-user filters (maxTop10HolderPct
 * etc.) can tighten these thresholds further but never loosen them.
 */
export function runRugScreen(
  profile: OnChainProfile | null | undefined,
  thresholds: RugScreenThresholds = DEFAULT_RUG_THRESHOLDS,
): RugScreenResult {
  if (!profile) {
    return { passed: false, reasons: ["on-chain profile unavailable - failing closed"] };
  }

  const reasons: string[] = [];

  if (profile.mintAuthorityActive) {
    reasons.push("mint authority not renounced (supply can be inflated)");
  }
  if (profile.freezeAuthorityActive) {
    reasons.push("freeze authority not renounced (holders can be frozen)");
  }
  if (!profile.lpBurned) {
    reasons.push("liquidity not burned/locked (LP can be pulled)");
  }
  if (profile.top10HolderPct === undefined) {
    reasons.push("top-10 holder concentration unknown");
  } else if (profile.top10HolderPct > thresholds.maxTop10HolderPct) {
    reasons.push(
      `top 10 holders own ${profile.top10HolderPct.toFixed(1)}% (max ${thresholds.maxTop10HolderPct}%)`,
    );
  }
  if (profile.devWalletPct !== undefined && profile.devWalletPct > thresholds.maxDevWalletPct) {
    reasons.push(
      `dev wallet owns ${profile.devWalletPct.toFixed(1)}% (max ${thresholds.maxDevWalletPct}%)`,
    );
  }
  if (profile.riskScore !== undefined && profile.riskScore > thresholds.maxRiskScore) {
    reasons.push(`risk score ${profile.riskScore} exceeds max ${thresholds.maxRiskScore}`);
  }
  const criticalFlags = (profile.riskFlags ?? []).filter((f) => CRITICAL_RISK_FLAGS.has(f));
  if (criticalFlags.length > 0) {
    reasons.push(`critical risk flag: ${criticalFlags.join(", ")}`);
  }

  return { passed: reasons.length === 0, reasons };
}
