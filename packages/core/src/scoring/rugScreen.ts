import { Prisma } from "@prisma/client";
import type { OnChainProfile, RugScreenResult } from "../types.js";

/** Above this share of the top-10 holders on wallets under a day old, a token is never alerted. */
export const SAFETY_MAX_FRESH_WALLET_PCT = 70;

/**
 * At or above this share of the top-10 holders on empty wallets (no other real holdings), a token
 * is never alerted. "At or above", unlike the fresh-wallet "over": top-10 lists come in steps of
 * 10%, so the old "over 90" rejected 100% only and let 9-of-10-empty through.
 *
 * 80 since 2026-10-07. The figure is a floor (unpriced holdings count as nothing), and under the
 * DAS pricing 70-90% empty did as well as the rest (notes/safety-precheck-review-2026-10-06.md).
 * The balances pricing (#196) reads the same wallets differently: on its first day of event rows
 * 80% empty fell 80% inside the hour 35% of the time and 90% did 42%, against 6-9% under 70%,
 * and the models were calling them because they pump first. 70% (19%) is left to the models and
 * to user filters.
 */
export const SAFETY_REJECT_EMPTY_WALLET_PCT = 80;

/**
 * At or above this share of the top-10 holders (pool and LP aside) being the launch's own first 25
 * buyers, a token is never alerted (user decision 2026-10-08): the snipers still own the book, and
 * they sell into whoever buys next. "At or above" for the same 10%-steps reason as the empty cut.
 */
export const SAFETY_REJECT_SNIPER_WALLET_PCT = 80;

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

  reasons.push(
    ...walletScreenReasons(
      profile.freshTop10WalletPct,
      profile.emptyTop10WalletPct,
      profile.sniperTop10WalletPct,
    ),
  );

  return { passed: reasons.length === 0, reasons };
}

/**
 * The screen's three top-10 wallet cuts. A holder list that is mostly brand-new wallets is a sniper
 * or insider farm, one that is mostly empty wallets (funded only to hold this launch) is a
 * bundled or farmed launch, and one that is mostly the launch's first buyers is still the snipers'
 * book - whatever anyone's filter says. Each applies only once measured: until
 * the wallet lookups land the figure is unknown, and model calls wait for it anyway
 * (CURATED_REQUIRE_WALLET_CHECKS).
 */
function walletScreenReasons(
  freshPct: number | null | undefined,
  emptyPct: number | null | undefined,
  sniperPct?: number | null,
): string[] {
  const reasons: string[] = [];
  if (typeof freshPct === "number" && freshPct > SAFETY_MAX_FRESH_WALLET_PCT) {
    reasons.push(
      `${freshPct.toFixed(0)}% of top-10 holders are fresh wallets (over ${SAFETY_MAX_FRESH_WALLET_PCT}%)`,
    );
  }
  if (typeof emptyPct === "number" && emptyPct >= SAFETY_REJECT_EMPTY_WALLET_PCT) {
    reasons.push(
      `${emptyPct.toFixed(0)}% of top-10 holders are empty wallets (${SAFETY_REJECT_EMPTY_WALLET_PCT}% or more)`,
    );
  }
  if (typeof sniperPct === "number" && sniperPct >= SAFETY_REJECT_SNIPER_WALLET_PCT) {
    reasons.push(
      `${sniperPct.toFixed(0)}% of top-10 holders are launch snipers (${SAFETY_REJECT_SNIPER_WALLET_PCT}% or more)`,
    );
  }
  return reasons;
}

/**
 * Whether a banked row's stored features clear the screen's wallet cuts as they stand now. Rows
 * banked before a cut existed or was tightened passed the screen of their day, and a token the
 * live screen now rejects is not one a curator is ever asked about - so training, the exam and
 * the score's fit leave such rows out rather than learn from tokens that are mostly farm rugs.
 */
export function passesWalletSafetyCuts(features: Record<string, number | null | undefined>): boolean {
  return (
    walletScreenReasons(
      features.freshTop10WalletPct,
      features.emptyTop10WalletPct,
      features.sniperTop10WalletPct,
    ).length === 0
  );
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

/**
 * passesWalletSafetyCuts as a SQL condition on a CandidateOutcome features column (default
 * "features"; pass e.g. `co."features"` for an aliased table), for the reports that count banked
 * decision moments: rows the screen would reject today leave the base rates they are compared to.
 */
export function walletSafetyCutsSql(features: Prisma.Sql = Prisma.raw('"features"')): Prisma.Sql {
  return Prisma.sql`COALESCE((${features}->>'emptyTop10WalletPct')::float8 < ${SAFETY_REJECT_EMPTY_WALLET_PCT}, true)
    AND COALESCE((${features}->>'freshTop10WalletPct')::float8 <= ${SAFETY_MAX_FRESH_WALLET_PCT}, true)
    AND COALESCE((${features}->>'sniperTop10WalletPct')::float8 < ${SAFETY_REJECT_SNIPER_WALLET_PCT}, true)`;
}
