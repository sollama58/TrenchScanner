import { isWalletAddress } from "../solana.js";

/**
 * The top-10 holder figures read straight from the chain, for a mint RugCheck has no report for
 * (not indexed yet, or RugCheck down). RugCheck's report is still preferred: it also carries the
 * creator, the holder count and its risk score, none of which the chain gives in one read.
 */

/** One token account from getTokenLargestAccounts, with the wallet that owns it. */
export interface LargestAccount {
  owner: string;
  /** Raw amount (base units). */
  amount: bigint;
}

export interface OnChainHolders {
  /** % of supply held by the ten largest wallets; undefined when the shares can't be trusted. */
  top10HolderPct?: number;
  /** % of supply held by the largest wallet; undefined when the shares can't be trusted. */
  largestHolderPct?: number;
  /** The ten largest wallets, largest first. */
  top10HolderAddresses: string[];
}

const TOP_N = 10;
/** Shares of one supply cannot sum past 100 - see the same guard in rugcheck.ts. */
const MAX_TOP10_SHARE_PCT = 100;

/**
 * The top ten wallets and their share of supply. Accounts owned by a program-derived address are
 * left out: those are the Pump.fun bonding curve and AMM pools (the same exclusion RugCheck's
 * markets list gives toProfile), not holders who can sell into anyone. One wallet's several token
 * accounts count once, summed. Null when the supply is unknown or zero.
 */
export function holdersFromLargestAccounts(
  accounts: LargestAccount[],
  supply: bigint,
): OnChainHolders | null {
  if (supply <= 0n) return null;
  const byOwner = new Map<string, bigint>();
  for (const a of accounts) {
    if (a.amount <= 0n || !isWalletAddress(a.owner)) continue;
    byOwner.set(a.owner, (byOwner.get(a.owner) ?? 0n) + a.amount);
  }
  const top = [...byOwner.entries()].sort((x, y) => (y[1] > x[1] ? 1 : y[1] < x[1] ? -1 : 0)).slice(0, TOP_N);
  const held = top.reduce((sum, [, amount]) => sum + amount, 0n);
  // Hundredths of a percent, in integers, so a 1e9-supply mint's figures don't lose precision.
  const pct = Number((held * 10_000n) / supply) / 100;
  const largest = top.length > 0 ? Number((top[0]![1] * 10_000n) / supply) / 100 : undefined;
  return {
    top10HolderPct: pct <= MAX_TOP10_SHARE_PCT ? pct : undefined,
    largestHolderPct: pct <= MAX_TOP10_SHARE_PCT ? largest : undefined,
    top10HolderAddresses: top.map(([owner]) => owner),
  };
}

/** The system program's address: the owner a closed token account reads as, never a holder. */
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

/**
 * The `n` largest wallets among every token account of a mint, with each one's % of supply,
 * largest first. Accounts owned by a program-derived address (the bonding curve, an AMM pool's
 * vault) are left out, as RugCheck leaves out the pools its markets list names; one wallet's
 * several accounts count once, summed. Only the largest owners are tested for the curve, so a
 * coin with thousands of holders costs a few dozen checks. Null when the supply is unknown or zero.
 */
export function topWalletsFromAccounts(
  accounts: readonly LargestAccount[],
  supply: bigint,
  n: number,
): { owner: string; pct: number }[] | null {
  if (supply <= 0n) return null;
  const byOwner = new Map<string, bigint>();
  for (const a of accounts) {
    if (a.amount <= 0n || a.owner === SYSTEM_PROGRAM) continue;
    byOwner.set(a.owner, (byOwner.get(a.owner) ?? 0n) + a.amount);
  }
  const sorted = [...byOwner.entries()].sort((x, y) => (y[1] > x[1] ? 1 : y[1] < x[1] ? -1 : 0));
  const out: { owner: string; pct: number }[] = [];
  for (const [owner, amount] of sorted) {
    if (out.length >= n) break;
    if (!isWalletAddress(owner)) continue;
    out.push({ owner, pct: Number((amount * 1_000_000n) / supply) / 10_000 });
  }
  return out;
}
