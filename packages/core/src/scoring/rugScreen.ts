import { Prisma } from "@prisma/client";
import type { OnChainProfile, RugScreenResult } from "../types.js";
import {
  SAFETY_MAX_FRESH_WALLET_PCT,
  SAFETY_REJECT_EMPTY_WALLET_PCT,
  SAFETY_REJECT_BLOCK_ZERO_HELD_PCT,
  SAFETY_REJECT_TOP10_HOLDER_PCT,
  SAFETY_REJECT_CEX_FUNDED_COUNT,
  SAFETY_REJECT_LINKED_COUNT,
  SAFETY_REJECT_CEX_FUNDED_PCT,
  SAFETY_COUNT_CUT_HOLDERS,
  countCutFor,
  SAFETY_MAX_LARGEST_HOLDER_PCT,
  SAFETY_MIN_PREBOND_SECONDS,
} from "../screenCuts.js";

export * from "../screenCuts.js";

/** The fresh-wallet fields freshWalletShare reads, on a profile, a scored token or banked features. */
export interface FreshWalletFields {
  freshTopHolderCount?: number | null;
  freshTopHoldersChecked?: number | null;
  freshTop10WalletPct?: number | null;
}

/**
 * The share of the top holders on fresh wallets that the screen, the pick rule and the filters
 * read: over the chain's top 25 when that count is in (user decision 2026-10-14, "N/25"), else
 * over the top 10. Undefined while neither is known.
 */
export function freshWalletShare(f: FreshWalletFields): number | undefined {
  if (
    typeof f.freshTopHolderCount === "number" &&
    typeof f.freshTopHoldersChecked === "number" &&
    f.freshTopHoldersChecked > 0
  ) {
    return (f.freshTopHolderCount / f.freshTopHoldersChecked) * 100;
  }
  return typeof f.freshTop10WalletPct === "number" ? f.freshTop10WalletPct : undefined;
}

/** The fresh-wallet cut's reason, or null when it passes or is unknown. */
function freshReason(f: FreshWalletFields): string | null {
  const share = freshWalletShare(f);
  if (share === undefined || share <= SAFETY_MAX_FRESH_WALLET_PCT) return null;
  if (
    typeof f.freshTopHolderCount === "number" &&
    typeof f.freshTopHoldersChecked === "number" &&
    f.freshTopHoldersChecked > 0
  ) {
    return `${f.freshTopHolderCount} of the ${f.freshTopHoldersChecked} top holders are fresh wallets (over ${SAFETY_MAX_FRESH_WALLET_PCT}%)`;
  }
  return `${share.toFixed(0)}% of top-10 holders are fresh wallets (over ${SAFETY_MAX_FRESH_WALLET_PCT}%)`;
}

/**
 * Hard exclusion gate. A token must pass this before it's ever shown to a
 * user, independent of their filter settings - this is the "auto-filter
 * scams" behavior chosen in planning, not something users can turn off.
 *
 * Deliberately narrow: only the signals where "unverifiable or bad"
 * has one universally-correct answer regardless of a user's own risk
 * tolerance. Top-10 concentration beyond SAFETY_REJECT_TOP10_HOLDER_PCT is one
 * (a user filter can still be stricter below it); dev wallet %, RugCheck's composite risk
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
 * at all, or one without its top-holder list, that's a fail rather than letting an
 * unverifiable token through.
 */
export function runRugScreen(profile: OnChainProfile | null | undefined): RugScreenResult {
  if (!profile) {
    return { passed: false, reasons: ["on-chain profile unavailable - failing closed"] };
  }

  const reasons = [...localScreenReasons(profile)];
  const localFailed = reasons.length > 0;

  // Mayhem Mode tokens have an extra 1B supply minted and traded by Pump.fun's own AI agents for
  // their first 24h, with whatever goes unsold burned afterwards. Every market signal this app
  // scores on - volume, buy/sell pressure, holder growth, momentum - is manufactured during that
  // window, so a Mayhem token's numbers don't mean what they mean for any other token. Excluded
  // outright, in both bonding-curve and graduated state, rather than scored on figures that
  // aren't comparable. `!== false` rather than `=== true`: an unverified mint (undefined, the
  // check errored) is rejected too, consistent with this screen failing closed everywhere else.
  // Unchecked is not "unverified" when a local check already failed: Mayhem is looked up only for
  // coins passing those (the scan's two-pass assembly), so every LP or authority reject read
  // "Mayhem unverified" too and the per-rule counts overstated it (audit 2026-10-14, L3 M3). The
  // verdict is the same either way.
  const mayhemUnchecked = profile.isMayhemMode === undefined && localFailed;
  if (profile.isMayhemMode !== false && !mayhemUnchecked) {
    reasons.push(
      profile.isMayhemMode === true
        ? "Pump.fun Mayhem Mode token (AI-driven supply and trading)"
        : "Mayhem Mode status unverified - failing closed",
    );
  }

  // The holder list behind every holder cut: the top ten's share and the largest holder's, and
  // the wallets the fresh, empty, sniper, linked and exchange-funded checks look up. Without it
  // none of them can run, and a coin with RugCheck down and the chain's read failed passed with
  // every holder check unread (an obvious rug on 2026-10-20). Unread fails, like Mayhem above;
  // the wallet checks that follow from a read list still apply only once measured. Skipped when a
  // local check already failed, for the same reason as Mayhem: holders aren't read for those.
  if (typeof profile.top10HolderPct !== "number" && !localFailed) {
    reasons.push("top holders not read - failing closed");
  }

  // Applies only once measured, like the wallet cuts: a token whose launch or graduation time is
  // unknown passes this one.
  const minPreBond = profile.minPreBondSeconds ?? SAFETY_MIN_PREBOND_SECONDS;
  if (typeof profile.preBondSeconds === "number" && profile.preBondSeconds < minPreBond) {
    reasons.push(
      `bonding curve filled ${Math.max(0, profile.preBondSeconds).toFixed(0)}s after launch (under ${minPreBond}s)`,
    );
  }

  reasons.push(
    ...walletScreenReasons(
      profile,
      profile.emptyTop10WalletPct,
      profile.blockZeroHeldPct,
      profile.top10HolderPct,
    ),
  );
  if (
    typeof profile.largestHolderPct === "number" &&
    profile.largestHolderPct > SAFETY_MAX_LARGEST_HOLDER_PCT
  ) {
    reasons.push(
      `largest holder owns ${profile.largestHolderPct.toFixed(1)}% of supply (over ${SAFETY_MAX_LARGEST_HOLDER_PCT}%)`,
    );
  }
  const linkedCut = countCutFor(SAFETY_REJECT_LINKED_COUNT, profile.linkedWalletsChecked);
  if (typeof profile.linkedWalletCount === "number" && profile.linkedWalletCount >= linkedCut) {
    reasons.push(
      `${profile.linkedWalletCount} of the ${profile.linkedWalletsChecked ?? SAFETY_COUNT_CUT_HOLDERS} top holders are linked (${linkedCut} or more)`,
    );
  }
  const cexCut = countCutFor(SAFETY_REJECT_CEX_FUNDED_COUNT, profile.cexFundedHolders);
  if (typeof profile.cexFundedCount === "number" && profile.cexFundedCount >= cexCut) {
    reasons.push(
      `${profile.cexFundedCount} of the ${profile.cexFundedHolders ?? SAFETY_COUNT_CUT_HOLDERS} top holders were funded from an exchange (${cexCut} or more)`,
    );
  }

  return { passed: reasons.length === 0, reasons };
}

/**
 * The screen's wallet cuts: two on who the top-10 wallets are, two on how much of the supply sits
 * where it can be sold. A holder list that is mostly fresh wallets (new, or woken after a week idle) is a sniper
 * or insider farm, one that is mostly empty wallets (funded only to hold this launch) is a
 * bundled or farmed launch, and block zero's wallets still holding 10% of the supply is the snipers'
 * book - whatever anyone's filter says. A top ten owning 40% of the supply or more can sell it out from
 * under anyone. Each applies only once measured: until
 * the wallet lookups land the figure is unknown, and model calls wait for it anyway
 * (CURATED_REQUIRE_WALLET_CHECKS).
 */
function walletScreenReasons(
  fresh: FreshWalletFields,
  emptyPct: number | null | undefined,
  blockZeroPct?: number | null,
  top10Pct?: number | null,
): string[] {
  const reasons: string[] = [];
  const freshCut = freshReason(fresh);
  if (freshCut) reasons.push(freshCut);
  if (typeof emptyPct === "number" && emptyPct >= SAFETY_REJECT_EMPTY_WALLET_PCT) {
    reasons.push(
      `${emptyPct.toFixed(0)}% of top-10 holders are empty wallets (${SAFETY_REJECT_EMPTY_WALLET_PCT}% or more)`,
    );
  }
  if (typeof blockZeroPct === "number" && blockZeroPct >= SAFETY_REJECT_BLOCK_ZERO_HELD_PCT) {
    reasons.push(
      `block-zero snipers hold ${blockZeroPct.toFixed(1)}% of supply (${SAFETY_REJECT_BLOCK_ZERO_HELD_PCT}% or more)`,
    );
  }
  if (typeof top10Pct === "number" && top10Pct >= SAFETY_REJECT_TOP10_HOLDER_PCT) {
    reasons.push(
      `top-10 holders own ${top10Pct.toFixed(0)}% of supply (${SAFETY_REJECT_TOP10_HOLDER_PCT}% or more)`,
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
  const num = (v: number | null | undefined): v is number => typeof v === "number";
  // The exchange-funded cut on the count where the row banked it, else on the share.
  const cexFails = num(features.cexFundedCount)
    ? features.cexFundedCount >= countCutFor(SAFETY_REJECT_CEX_FUNDED_COUNT, features.cexFundedHolders)
    : num(features.cexFundedPct) && features.cexFundedPct >= SAFETY_REJECT_CEX_FUNDED_PCT;
  return (
    walletScreenReasons(
      features,
      features.emptyTop10WalletPct,
      features.blockZeroHeldPct,
      features.top10HolderPct,
    ).length === 0 &&
    !cexFails &&
    !(
      num(features.linkedWalletCount) &&
      features.linkedWalletCount >= countCutFor(SAFETY_REJECT_LINKED_COUNT, features.linkedWalletsChecked)
    ) &&
    !(num(features.largestHolderPct) && features.largestHolderPct > SAFETY_MAX_LARGEST_HOLDER_PCT)
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
    AND COALESCE(
      COALESCE(
        CASE WHEN (${features}->>'freshTopHoldersChecked')::float8 > 0
          THEN (${features}->>'freshTopHolderCount')::float8 * 100 / (${features}->>'freshTopHoldersChecked')::float8
        END,
        (${features}->>'freshTop10WalletPct')::float8
      ) <= ${SAFETY_MAX_FRESH_WALLET_PCT},
      true
    )
    AND COALESCE((${features}->>'blockZeroHeldPct')::float8 < ${SAFETY_REJECT_BLOCK_ZERO_HELD_PCT}, true)
    AND COALESCE((${features}->>'top10HolderPct')::float8 < ${SAFETY_REJECT_TOP10_HOLDER_PCT}, true)
    AND COALESCE(
      (${features}->>'cexFundedCount')::float8 < ${countCutSql(SAFETY_REJECT_CEX_FUNDED_COUNT, Prisma.sql`(${features}->>'cexFundedHolders')::float8`)},
      (${features}->>'cexFundedPct')::float8 < ${SAFETY_REJECT_CEX_FUNDED_PCT},
      true
    )
    AND COALESCE((${features}->>'linkedWalletCount')::float8 < ${countCutSql(SAFETY_REJECT_LINKED_COUNT, Prisma.sql`(${features}->>'linkedWalletsChecked')::float8`)}, true)
    AND COALESCE((${features}->>'largestHolderPct')::float8 <= ${SAFETY_MAX_LARGEST_HOLDER_PCT}, true)`;
}

/** countCutFor in SQL, over a holders-read expression (null or 25 and over keep the cut as set). */
function countCutSql(cut: number, checked: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(CASE WHEN ${checked} > 0 AND ${checked} < ${SAFETY_COUNT_CUT_HOLDERS}
    THEN CEIL(${cut}::float8 * ${checked} / ${SAFETY_COUNT_CUT_HOLDERS}) ELSE ${cut} END)`;
}
