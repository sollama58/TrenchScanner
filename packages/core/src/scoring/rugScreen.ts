import type { OnChainProfile, RugScreenResult } from "../types.js";

/**
 * Hard exclusion gate. A token must pass this before it's ever shown to a
 * user, independent of their filter settings - this is the "auto-filter
 * scams" behavior chosen in planning, not something users can turn off.
 *
 * Deliberately narrow: only the three signals where "unverifiable or bad"
 * has one universally-correct answer regardless of a user's own risk
 * tolerance. Top-10 concentration, dev wallet %, RugCheck's composite risk
 * score, and its named risk flags used to live here too, but different
 * users legitimately want different thresholds for those (a degen chasing
 * fresh launches tolerates concentration a conservative buyer won't) - they
 * now live as opt-in criteria on UserFilter/matchesFilter instead (see
 * matchFilters.ts). Moving them out is a real behavior change, not just a
 * refactor: a token with completely unknown top-10 concentration, or an
 * unidentified creator, is no longer auto-rejected - it surfaces unless a
 * user's own filter explicitly excludes it.
 *
 * Fails closed on what's left: if we don't have a verified on-chain profile
 * at all, that's a fail rather than letting an unverifiable token through.
 */
export function runRugScreen(profile: OnChainProfile | null | undefined): RugScreenResult {
  if (!profile) {
    return { passed: false, reasons: ["on-chain profile unavailable - failing closed"] };
  }

  const reasons = [...localScreenReasons(profile)];

  // Mayhem Mode tokens have an extra 1B supply minted and traded by Pump.fun's own AI agents for
  // their first 24h, with whatever goes unsold burned afterwards. Every market signal this app
  // scores on - volume, buy/sell pressure, holder growth, momentum - is manufactured during that
  // window, so a Mayhem token's numbers don't mean what they mean for any other token. Excluded
  // outright, in both bonding-curve and graduated state, rather than scored on figures that
  // aren't comparable. `!== false` rather than `=== true`: an unverified mint (undefined, the
  // check errored) is rejected too, consistent with this screen failing closed everywhere else.
  if (profile.isMayhemMode !== false) {
    reasons.push(
      profile.isMayhemMode === true
        ? "Pump.fun Mayhem Mode token (AI-driven supply and trading)"
        : "Mayhem Mode status unverified - failing closed",
    );
  }

  return { passed: reasons.length === 0, reasons };
}

/** The screen's conditions that are already in hand from the RugCheck profile - no network call. */
function localScreenReasons(profile: OnChainProfile): string[] {
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
  return reasons;
}

/**
 * Everything runRugScreen checks EXCEPT Mayhem Mode - i.e. every condition answerable from data
 * already in hand, with no RPC call.
 *
 * This exists so the scan can spend its Mayhem lookups only where they can change an outcome.
 * Mayhem is the one screen condition that costs a Helius call per mint, and a candidate that
 * already fails on authorities or LP is rejected whatever the answer turns out to be - so
 * checking it first and only resolving Mayhem for the survivors is free savings, on the exact
 * path (first sight of a mint) that dominates the recurring cost. Fails closed on a missing
 * profile, same as the full screen.
 */
export function passesLocalRugScreen(profile: OnChainProfile | null | undefined): boolean {
  if (!profile) return false;
  return localScreenReasons(profile).length === 0;
}

/**
 * Named RugCheck risk flags severe enough that most users would want them
 * excluded outright rather than weighed numerically - shared with
 * matchesFilter's excludeCriticalRiskFlags criterion so the definition
 * lives in exactly one place.
 *
 * "Creator identity unknown" is synthesized in rugcheck.ts's toProfile(),
 * not RugCheck's own risks[] - it exists specifically to distinguish
 * "creator is genuinely unidentifiable" from the far more common, benign
 * case of a creator who simply holds too little to appear in the
 * top-holders list (that case leaves devWalletPct undefined without this
 * flag - see the comment in rugcheck.ts).
 */
export const CRITICAL_RISK_FLAGS = new Set(["Creator history of rugged tokens", "Creator identity unknown"]);
