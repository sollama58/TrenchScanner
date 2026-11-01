import type { LaunchBuyer } from "../datasources/launchBuyers.js";
import type { TapeTrade } from "./tradeTape.js";

/**
 * Same-second, same-size buy groups (data-uses evaluation 2026-11-01,
 * notes/data-uses-2026-11-01/report.md §3): three or more wallets that each bought once on the
 * page, for the same SOL to six decimals, in the same block second. One owner's script buying
 * from a row of wallets leaves this print; a crowd of real buyers does not (a plain same-second
 * burst fired on 91% of coins, the same size as well on 26%). On 17,139 production tapes the coins
 * carrying one reached 2x 11.7% of the time against 16.0% without, and a group holds a median
 * 1.4% of the supply - outside every existing bundle input, which reads funding and the create
 * transaction's slot, not the buys.
 *
 * Recorded only (curation/features.ts GROUP_HOLD_FEATURES); nothing decides on it.
 */
export const SAME_SIZE_MIN_WALLETS = 3;
const SOL_DECIMALS = 6;

export interface SameSizeGroupReading {
  /** Wallets in the page's largest same-second, same-size group; 0 when none has three. */
  sameSizeGroupWallets: number;
  /** The SOL those wallets bought as a share of the page's buy SOL (0-1); null with no buy SOL. */
  sameSizeGroupSolShare: number | null;
}

/**
 * The largest same-size group among a page's buys. On a page that starts at the launch
 * (`complete`) the launch second is left out: the create transaction's own slot is block zero,
 * read by the launch read (BLOCK_ZERO_FEATURES), and its buys share a second for that reason.
 */
export function sameSizeGroupReading(trades: readonly TapeTrade[], complete = false): SameSizeGroupReading {
  const buysOf = new Map<string, TapeTrade[]>();
  let buySol = 0;
  let firstSec = Infinity;
  for (const t of trades) {
    if (t.side !== "buy" || !(t.sol > 0)) continue;
    buySol += t.sol;
    const sec = Math.floor(t.atMs / 1000);
    if (sec < firstSec) firstSec = sec;
    const list = buysOf.get(t.wallet);
    if (list) list.push(t);
    else buysOf.set(t.wallet, [t]);
  }
  const groups = new Map<string, { wallets: number; sol: number }>();
  for (const [, buys] of buysOf) {
    if (buys.length !== 1) continue;
    const b = buys[0]!;
    const sec = Math.floor(b.atMs / 1000);
    if (complete && sec === firstSec) continue;
    const key = `${sec}:${b.sol.toFixed(SOL_DECIMALS)}`;
    const g = groups.get(key) ?? { wallets: 0, sol: 0 };
    g.wallets += 1;
    g.sol += b.sol;
    groups.set(key, g);
  }
  let best: { wallets: number; sol: number } | undefined;
  for (const g of groups.values()) {
    if (g.wallets >= SAME_SIZE_MIN_WALLETS && (!best || g.wallets > best.wallets)) best = g;
  }
  if (!best) return { sameSizeGroupWallets: 0, sameSizeGroupSolShare: buySol > 0 ? 0 : null };
  return {
    sameSizeGroupWallets: best.wallets,
    sameSizeGroupSolShare: buySol > 0 ? Math.round((best.sol / buySol) * 1000) / 1000 : null,
  };
}

/**
 * The same print on the launch read's first buyers, which carry tokens bought and a slot rather
 * than SOL and a second: three or more wallets that bought the same tokens to the base unit in
 * the same slot, the create transaction's slot aside (that is block zero). Null when the provider
 * gave no slots; 0 when no three match.
 */
export function launchSameSizeWallets(
  buyers: readonly Pick<LaunchBuyer, "wallet" | "bought" | "slot">[],
  createSlot: number | null,
): number | null {
  if (buyers.length === 0 || buyers.every((b) => b.slot === null)) return null;
  const groups = new Map<string, Set<string>>();
  for (const b of buyers) {
    if (b.slot === null || b.slot === createSlot || !(b.bought > 0)) continue;
    const key = `${b.slot}:${b.bought}`;
    const set = groups.get(key) ?? new Set<string>();
    set.add(b.wallet);
    groups.set(key, set);
  }
  let best = 0;
  for (const set of groups.values())
    if (set.size >= SAME_SIZE_MIN_WALLETS && set.size > best) best = set.size;
  return best;
}
