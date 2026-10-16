import { isWalletAddress } from "../solana.js";
import type { ChainTx } from "./tradeTape.js";

/**
 * Holder-to-holder transfers (user ask 2026-10-16): top holders that sent the coin itself to, or
 * got it from, another top holder. A wallet that splits its bag across fresh wallets, or a dev
 * handing supply out, shows as plain transfers between the holders the map already draws.
 *
 * Only the coin's own balances are read: SOL, the quote coin and any other token moving in the
 * same transaction are ignored (reward wallets and fee splitters pay those out to holders). A
 * transaction where any program account's balance of the coin moved (the bonding curve, a pool's
 * vault, a router's account) is a trade, not a transfer, and is left out: two holders buying in
 * one bundled transaction don't read as one sending to the other.
 *
 * This file is the pure half. apps/worker/src/jobs/holderTransfers.ts finds the transactions: a
 * transfer between two holders touches both of their token accounts, so it is in both accounts'
 * signature lists, and only those shared signatures are read.
 */

/** How many of the largest holders are read for transfers, as for the Linked count (core's LINKED_TOP_N). */
export const TRANSFER_TOP_N = 25;

/** One transaction's moves of the coin between wallets: who sent how much to whom (raw units). */
export interface TransferMove {
  from: string;
  to: string;
  /** Raw amount (base units), as a decimal string so it survives JSON. */
  amount: string;
}

/** A sender and a receiver among the top holders, with what passed between them. */
export interface HolderTransfer {
  from: string;
  to: string;
  /** % of supply sent from `from` to `to`, over every transfer between them. */
  pct: number;
  /** How many transfers. */
  count: number;
  /** The newest one, ms epoch; null when the transaction had no block time. */
  lastAtMs: number | null;
}

export interface HolderTransfersReading {
  /** Every directed pair of top holders with a transfer between them, largest first. */
  transfers: HolderTransfer[];
  /** Transferred Supply %: the supply that moved holder to holder, every transfer counted. */
  transferredSupplyPct: number;
  /** How many of the holders checked sent or received a transfer from another. */
  transferWalletCount: number;
  /** How many holders were checked (the top 25, the creator too when it holds). */
  holdersChecked: number;
}

interface RawBalance {
  accountIndex?: number;
  mint?: string;
  owner?: string;
  uiTokenAmount?: { amount?: string };
}

/**
 * The coin's moves between wallets in one transaction, or null when it is not a transfer: failed,
 * no coin moved, or a program account (the curve, a pool, a router) held a share of the move.
 * Each receiver's gain is split across the senders in proportion to what each sent, so a
 * transaction with one sender and several receivers (an airdrop, a split) reads as one move to each.
 */
export function transferMovesOf(
  mint: string,
  tx: ChainTx | null | undefined,
  walletCheck: (address: string) => boolean = isWalletAddress,
): TransferMove[] | null {
  if (!tx?.meta || tx.meta.err) return null;
  const deltas = new Map<string, bigint>();
  const add = (balances: unknown, sign: 1n | -1n) => {
    for (const b of (Array.isArray(balances) ? balances : []) as RawBalance[]) {
      if (b?.mint !== mint || typeof b.owner !== "string") continue;
      const raw = b.uiTokenAmount?.amount;
      if (typeof raw !== "string" || !/^\d+$/.test(raw)) continue;
      deltas.set(b.owner, (deltas.get(b.owner) ?? 0n) + sign * BigInt(raw));
    }
  };
  add(tx.meta.preTokenBalances, -1n);
  add(tx.meta.postTokenBalances, 1n);
  const moved = [...deltas].filter(([, d]) => d !== 0n);
  if (moved.length < 2) return null;
  // A program account's balance moved: a swap or a routed trade, not a wallet-to-wallet transfer.
  if (moved.some(([owner]) => !walletCheck(owner))) return null;
  const senders = moved.filter(([, d]) => d < 0n).map(([o, d]) => [o, -d] as const);
  const receivers = moved.filter(([, d]) => d > 0n);
  const sent = senders.reduce((t, [, d]) => t + d, 0n);
  if (senders.length === 0 || receivers.length === 0 || sent === 0n) return null;
  const out: TransferMove[] = [];
  for (const [to, got] of receivers) {
    for (const [from, gave] of senders) {
      const amount = (got * gave) / sent;
      if (amount > 0n && from !== to) out.push({ from, to, amount: amount.toString() });
    }
  }
  return out.length > 0 ? out : null;
}

/**
 * The reading over a coin's top holders from the moves of the transactions they share, each
 * transaction once. Moves to or from wallets outside `holders` are left out. `supply` is the coin's
 * raw supply; null without one (the share can't be told).
 */
export function holderTransfersReading(
  holders: readonly string[],
  moves: Iterable<{ atMs: number | null; moves: readonly TransferMove[] }>,
  supply: bigint,
): HolderTransfersReading | null {
  if (supply <= 0n || holders.length === 0) return null;
  const set = new Set(holders);
  const pairs = new Map<
    string,
    { from: string; to: string; amount: bigint; count: number; lastAtMs: number | null }
  >();
  for (const tx of moves) {
    for (const m of tx.moves) {
      if (!set.has(m.from) || !set.has(m.to) || m.from === m.to) continue;
      const key = `${m.from}>${m.to}`;
      const p = pairs.get(key) ?? { from: m.from, to: m.to, amount: 0n, count: 0, lastAtMs: null };
      p.amount += BigInt(m.amount);
      p.count += 1;
      if (tx.atMs !== null && (p.lastAtMs === null || tx.atMs > p.lastAtMs)) p.lastAtMs = tx.atMs;
      pairs.set(key, p);
    }
  }
  const pctOf = (amount: bigint) => Number((amount * 1_000_000n) / supply) / 10_000;
  const transfers = [...pairs.values()]
    .map((p) => ({ from: p.from, to: p.to, pct: pctOf(p.amount), count: p.count, lastAtMs: p.lastAtMs }))
    .sort((a, b) => b.pct - a.pct || b.count - a.count);
  const total = [...pairs.values()].reduce((t, p) => t + p.amount, 0n);
  const wallets = new Set(transfers.flatMap((t) => [t.from, t.to]));
  return {
    transfers,
    transferredSupplyPct: Math.round(pctOf(total) * 100) / 100,
    transferWalletCount: wallets.size,
    holdersChecked: holders.length,
  };
}

/**
 * The signatures that touch two or more different holders' token accounts: the only transactions
 * that can be a transfer between them. `accountsOf`: each holder's token accounts of the coin;
 * `signaturesOf`: each account's successful signatures.
 */
export function sharedSignatures(
  accountsOf: ReadonlyMap<string, readonly string[]>,
  signaturesOf: (account: string) => Iterable<string>,
): Set<string> {
  const ownersOf = new Map<string, Set<string>>();
  for (const [owner, accounts] of accountsOf) {
    for (const account of accounts) {
      for (const sig of signaturesOf(account)) {
        const owners = ownersOf.get(sig) ?? new Set<string>();
        owners.add(owner);
        ownersOf.set(sig, owners);
      }
    }
  }
  return new Set([...ownersOf].filter(([, owners]) => owners.size > 1).map(([sig]) => sig));
}
