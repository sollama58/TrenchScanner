import { PROGRAM, associatedTokenAddress } from "./txGuard.js";
import type { RawTransaction, TokenBalanceEntry } from "./rpc.js";

/**
 * A wallet's trades in one coin, read from the chain: what the token modal's Pro chart marks
 * (buys and sells at their times) and its position and PnL are worked out from.
 *
 * Read from the signatures of the wallet's own token account for the mint - every transaction
 * that moved the coin in or out of the wallet touches it, and nothing else does - so it covers
 * trades made anywhere (another site, a bot, a phone wallet), not only the ones made here. Each
 * transaction's effect is the wallet's own before/after balances: its SOL (fees and rent
 * included, so a round trip's PnL is what the wallet really kept) and its tokens of the mint.
 */

export interface WalletTrade {
  signature: string;
  /** ms. */
  t: number;
  /** A buy (tokens in, SOL out), a sale (tokens out, SOL in), or a transfer in or out (no SOL for it). */
  side: "buy" | "sell" | "in" | "out";
  /** The wallet's SOL change, lamports (negative on a buy). */
  lamports: bigint;
  /** The wallet's change in the coin, raw units (negative on a sale). */
  tokens: bigint;
}

export interface WalletTradesRpc {
  getSignaturesForAddress(
    address: string,
    limit: number,
  ): Promise<{ signature: string; blockTime: number | null; failed: boolean }[] | null>;
  getTransactionJson(signature: string): Promise<RawTransaction | null>;
}

/** The transactions read back per wallet and coin, newest first. */
export const WALLET_TRADES_LIMIT = 60;
/** SOL out no larger than this alongside tokens in is the fees of a transfer, not a price. */
const FEE_ONLY_LAMPORTS = 50_000n;

/** One landed transaction's effect on the wallet's SOL and its `mint`; null when it moved no tokens. */
export function tradeOf(
  signature: string,
  tx: RawTransaction,
  wallet: string,
  mint: string,
): WalletTrade | null {
  const meta = tx.meta;
  if (!meta || meta.err != null || typeof tx.blockTime !== "number") return null;
  const keys = [
    ...(tx.transaction?.message?.accountKeys ?? []),
    ...(meta.loadedAddresses?.writable ?? []),
    ...(meta.loadedAddresses?.readonly ?? []),
  ];
  const at = keys.indexOf(wallet);
  const pre = at >= 0 ? meta.preBalances?.[at] : undefined;
  const post = at >= 0 ? meta.postBalances?.[at] : undefined;
  const lamports = typeof pre === "number" && typeof post === "number" ? BigInt(post) - BigInt(pre) : 0n;
  const total = (entries: TokenBalanceEntry[] | undefined) => {
    let sum = 0n;
    for (const e of entries ?? []) {
      if (e.owner !== wallet || e.mint !== mint) continue;
      const raw = e.uiTokenAmount?.amount;
      if (typeof raw === "string" && /^\d+$/.test(raw)) sum += BigInt(raw);
    }
    return sum;
  };
  const tokens = total(meta.postTokenBalances) - total(meta.preTokenBalances);
  if (tokens === 0n) return null;
  // Only a transaction the wallet paid for can be its trade; one paid by someone else that moved
  // its tokens was a transfer. And SOL out that is no more than fees is a transfer it paid for.
  const payer = at === 0;
  const side: WalletTrade["side"] =
    tokens > 0n
      ? payer && -lamports > FEE_ONLY_LAMPORTS
        ? "buy"
        : "in"
      : payer && lamports > 0n
        ? "sell"
        : "out";
  return { signature, t: tx.blockTime * 1000, side, lamports, tokens };
}

/**
 * The wallet's trades in `mint`, oldest first, from its token account(s) under both token
 * programs. `cache` keeps each transaction's reading for this wallet and coin (a landed transaction
 * never changes) across calls.
 * Null when the chain couldn't be read; `truncated` when older history was left out.
 */
export async function walletTokenTrades(
  rpc: WalletTradesRpc,
  wallet: string,
  mint: string,
  cache: Map<string, WalletTrade | null>,
  limit = WALLET_TRADES_LIMIT,
): Promise<{ trades: WalletTrade[]; truncated: boolean } | null> {
  const accounts = [PROGRAM.token, PROGRAM.token2022].map((p) => associatedTokenAddress(wallet, mint, p));
  const lists = await Promise.all(accounts.map((a) => rpc.getSignaturesForAddress(a, limit)));
  if (lists.some((l) => l === null)) return null;
  const truncated = lists.some((l) => l!.length >= limit);
  const signatures = [...new Set(lists.flatMap((l) => l!.filter((s) => !s.failed).map((s) => s.signature)))];
  // Keyed by wallet and coin too: one transaction can move several wallets' tokens, or two coins.
  const keyOf = (s: string) => `${wallet}:${mint}:${s}`;
  const missing = signatures.filter((s) => !cache.has(keyOf(s)));
  // A few at a time: a first open of a busy wallet's coin shouldn't fire sixty reads at once.
  for (let i = 0; i < missing.length; i += 8) {
    const batch = missing.slice(i, i + 8);
    const txs = await Promise.all(batch.map((s) => rpc.getTransactionJson(s)));
    batch.forEach((s, j) => {
      const tx = txs[j];
      // Not served yet (just landed), or no block time yet: asked again next time rather than
      // remembered as nothing.
      if (tx && typeof tx.blockTime === "number") cache.set(keyOf(s), tradeOf(s, tx, wallet, mint));
    });
  }
  const trades = signatures
    .map((s) => cache.get(keyOf(s)))
    .filter((t): t is WalletTrade => !!t)
    .sort((a, b) => a.t - b.t);
  return { trades, truncated };
}
