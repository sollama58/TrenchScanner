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
  /** The token account's own address, when the read gave it. */
  address?: string;
}

export interface OnChainHolders {
  /** % of supply held by the ten largest wallets; undefined when the shares can't be trusted. */
  top10HolderPct?: number;
  /** % of supply held by the largest wallet; undefined when the shares can't be trusted. */
  largestHolderPct?: number;
  /** The ten largest wallets, largest first. */
  top10HolderAddresses: string[];
  /**
   * Every wallet the read covered with its % of supply, largest first: what a RugCheck profile's
   * holder figures are recomputed from when the chain's reading replaces them (withChainHolders).
   * Absent when the shares can't be trusted.
   */
  topHolderShares?: { owner: string; pct: number }[];
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
  /** Wallets that are not holders of this coin (its fee wallet on a Stonks coin: stonksFees.ts). */
  exclude: ReadonlySet<string> = new Set(),
): OnChainHolders | null {
  if (supply <= 0n) return null;
  const byOwner = new Map<string, bigint>();
  for (const a of accounts) {
    if (a.amount <= 0n || exclude.has(a.owner) || !isWalletAddress(a.owner)) continue;
    byOwner.set(a.owner, (byOwner.get(a.owner) ?? 0n) + a.amount);
  }
  const sorted = [...byOwner.entries()].sort((x, y) => (y[1] > x[1] ? 1 : y[1] < x[1] ? -1 : 0));
  const top = sorted.slice(0, TOP_N);
  const held = top.reduce((sum, [, amount]) => sum + amount, 0n);
  // Hundredths of a percent, in integers, so a 1e9-supply mint's figures don't lose precision.
  const pct = Number((held * 10_000n) / supply) / 100;
  const largest = top.length > 0 ? Number((top[0]![1] * 10_000n) / supply) / 100 : undefined;
  const consistent = pct <= MAX_TOP10_SHARE_PCT;
  return {
    top10HolderPct: consistent ? pct : undefined,
    largestHolderPct: consistent ? largest : undefined,
    top10HolderAddresses: top.map(([owner]) => owner),
    ...(consistent
      ? {
          topHolderShares: sorted.map(([owner, amount]) => ({
            owner,
            pct: Number((amount * 1_000_000n) / supply) / 10_000,
          })),
        }
      : {}),
  };
}

/**
 * The holder figures of a list of wallets and their % of supply (pools already out, largest
 * first, as topWalletsFromAccounts reads them): the same shape holdersFromLargestAccounts answers.
 * Undefined for an empty list.
 */
export function holdersFromShares(
  shares: readonly { owner: string; pct: number }[],
): OnChainHolders | undefined {
  const byOwner = new Map<string, number>();
  for (const h of shares) if (h.pct > 0) byOwner.set(h.owner, (byOwner.get(h.owner) ?? 0) + h.pct);
  const sorted = [...byOwner.entries()].sort((a, b) => b[1] - a[1]).map(([owner, pct]) => ({ owner, pct }));
  if (sorted.length === 0) return undefined;
  const top = sorted.slice(0, TOP_N);
  const pct = top.reduce((sum, h) => sum + h.pct, 0);
  const consistent = pct <= MAX_TOP10_SHARE_PCT + 0.5;
  return {
    top10HolderPct: consistent ? pct : undefined,
    largestHolderPct: consistent ? sorted[0]!.pct : undefined,
    top10HolderAddresses: top.map((h) => h.owner),
    ...(consistent ? { topHolderShares: sorted } : {}),
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
  /** Wallets that are not holders of this coin (its fee wallet on a Stonks coin: stonksFees.ts). */
  exclude: ReadonlySet<string> = new Set(),
): { owner: string; pct: number; accounts?: string[] }[] | null {
  if (supply <= 0n) return null;
  const byOwner = new Map<string, bigint>();
  const accountsOf = new Map<string, string[]>();
  for (const a of accounts) {
    if (a.amount <= 0n || a.owner === SYSTEM_PROGRAM || exclude.has(a.owner)) continue;
    byOwner.set(a.owner, (byOwner.get(a.owner) ?? 0n) + a.amount);
    if (a.address) accountsOf.set(a.owner, [...(accountsOf.get(a.owner) ?? []), a.address]);
  }
  const sorted = [...byOwner.entries()].sort((x, y) => (y[1] > x[1] ? 1 : y[1] < x[1] ? -1 : 0));
  const out: { owner: string; pct: number; accounts?: string[] }[] = [];
  for (const [owner, amount] of sorted) {
    if (out.length >= n) break;
    if (!isWalletAddress(owner)) continue;
    const held = accountsOf.get(owner);
    // Each wallet's token accounts of the coin ride along for the holder-transfer read.
    out.push({
      owner,
      pct: Number((amount * 1_000_000n) / supply) / 10_000,
      ...(held ? { accounts: held } : {}),
    });
  }
  return out;
}
