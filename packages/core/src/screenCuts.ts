/**
 * The safety screen's cuts (rugScreen.ts reads them; it re-exports everything here). This file
 * imports nothing, so the web can take it from the screenCuts export under its
 * "trenchscanner-web" condition and test its own copies against it (audit 2026-10-27, SW-7), as it
 * does chartMarks.
 */

/**
 * Above this share of the top holders on fresh wallets (new, or used again after a week idle,
 * within a day), a token is never alerted: 18 of 25 or more (72%), or 8 of 10 where only the top
 * 10 were read (user decision 2026-10-14; read through freshWalletShare).
 */
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
 * At or above this share of the supply held by the wallets that bought in block zero (the create
 * transaction's own slot, the dev aside: the launch's snipers in the strict sense), a token is
 * never alerted (user decision 2026-10-22). It replaced the cut at 80% of the top-10 holders being
 * among the launch's first 25 buyers (user decision 2026-10-08), which fired on most coins in
 * their first minutes, where the top ten are those buyers by default, and held runners longest:
 * coins it rejected doubled as often as those it passed (notes/sniper-audit-2026-10-22). The
 * first-buyer share stays a model input and a filter.
 */
export const SAFETY_REJECT_BLOCK_ZERO_HELD_PCT = 10;

/**
 * At or above this share of the supply held by the top-10 holders (pool and LP aside), a token is
 * never alerted (user decision 2026-10-10). On alerts since 10-05 the cut takes about 3.5% of calls,
 * which doubled 15% of the time against 21% for the rest and fell 80% inside the hour half the
 * time against 12% (notes/top10-cut-eval-2026-10-09.md). Most readings this high are taken in the
 * first minutes after graduation, possibly before RugCheck lists the new pool.
 */
export const SAFETY_REJECT_TOP10_HOLDER_PCT = 40;

/**
 * At or above this many of the top-25 holders (pools and the creator aside) funded from an
 * exchange or a busy service (core's cexFundedReading), a token is never alerted (user decision
 * 2026-10-13, "17/20", first asked at 15; moved to the same 25 holders as Linked the same day, so
 * 21/25, the same 84-85%). Banked rows before the count was recorded keep the share only
 * (cexFundedPct), so the training and report cut reads those as SAFETY_REJECT_CEX_FUNDED_PCT.
 */
export const SAFETY_REJECT_CEX_FUNDED_COUNT = 21;

/**
 * At or above this many of the top-25 holders (pools aside) linked (one funder paid for them, or
 * they funded each other: core's linkedWallets, linkedWalletCount), a token is never alerted (user
 * decision 2026-10-13, "15/20", then 20/25 on the top 25). Banked rows carry it
 * as the linkedWalletCount feature since 2026-10-13; older rows have none and pass.
 */
export const SAFETY_REJECT_LINKED_COUNT = 20;
export const SAFETY_REJECT_CEX_FUNDED_PCT = 84;

/** The holder list the count cuts are set on: the top 25, pools aside (core's LINKED_TOP_N). */
export const SAFETY_COUNT_CUT_HOLDERS = 25;

/**
 * A count cut set on the top 25, for a reading that covered fewer holders: the same share of the
 * list, rounded up. A coin with 19 holders past its pools, or one read from RugCheck's 20 accounts
 * before the chain's top 25 came in, would otherwise need 20 of its 19 linked to fail - a cut that
 * can never fire. 20/25 on 19 read is 16/19; on 25 or more the cut stands as set.
 */
export function countCutFor(cut: number, checked: number | null | undefined): number {
  if (typeof checked !== "number" || checked <= 0 || checked >= SAFETY_COUNT_CUT_HOLDERS) return cut;
  return Math.ceil((cut * checked) / SAFETY_COUNT_CUT_HOLDERS);
}

/**
 * Over this share of the supply in one holder's hands (pools and LP aside, one wallet's token
 * accounts summed: largestHolderPct), a token is never alerted (user decision 2026-10-13). One
 * wallet that big can sell the chart out from under everyone on its own. "Over", not "at or
 * above": a holder on exactly 10% passes. Applies once measured; rows banked before the share was
 * recorded have none and pass.
 */
export const SAFETY_MAX_LARGEST_HOLDER_PCT = 10;

/**
 * A graduated token must have spent at least this long on its bonding curve (user decision
 * 2026-10-11, 10s at first, then 5s). A curve filled within seconds of launch is a coordinated bundle - the launcher's
 * own wallets buying the whole curve in the first blocks - and the bundle sells into whoever buys
 * the pool. The default; the scan applies SAFETY_MIN_PREBOND_SECONDS (0 turns the cut off).
 */
export const SAFETY_MIN_PREBOND_SECONDS = 5;
