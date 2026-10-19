import { PROGRAM, associatedTokenAddress } from "./txGuard.js";
import type { RawTransaction, TokenBalanceEntry } from "./rpc.js";

/**
 * A wallet's trades in one coin, read from the chain: what the token modal's Pro chart marks
 * (buys and sells at their times) and its position and PnL are worked out from.
 *
 * Read from the signatures of the wallet's own token account for the mint - every transaction
 * that moved the coin in or out of the wallet touches it, and nothing else does - so it covers
 * trades made anywhere (another site, a bot, a phone wallet), not only the ones made here. Each
 * transaction's effect is the wallet's own before/after balances: its SOL (network, priority and
 * platform fees and slippage included, so a trade's cost is what the wallet really paid) and its
 * tokens of the mint. The rent a token account is opened with is left out: it comes back when the
 * account is closed, so it is a deposit, not a cost, and counting it would put about 0.002 SOL on
 * every first buy and take it off the last sale.
 */

export interface WalletTrade {
  signature: string;
  /** ms. */
  t: number;
  /** A buy (tokens in, SOL out), a sale (tokens out, SOL in), or a transfer in or out (no SOL for it). */
  side: "buy" | "sell" | "in" | "out";
  /** The wallet's SOL change, lamports (negative on a buy): fees in, token-account rent left out. */
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

const WSOL = "So11111111111111111111111111111111111111112";

/**
 * The rent the wallet's token accounts were opened with in a transaction, less the rent its closed
 * ones gave back, lamports: what the wallet's SOL change holds that is neither a price nor a fee.
 * A wrapped-SOL account's balance beyond its rent is the wrapped SOL itself, which is not rent.
 */
export function tokenAccountRent(
  meta: {
    preBalances?: number[] | null;
    postBalances?: number[] | null;
    preTokenBalances?: TokenBalanceEntry[] | null;
    postTokenBalances?: TokenBalanceEntry[] | null;
  },
  wallet: string,
): bigint {
  const own = (entries: TokenBalanceEntry[] | null | undefined) => {
    const out = new Map<number, TokenBalanceEntry>();
    for (const e of entries ?? [])
      if (e.owner === wallet && typeof e.accountIndex === "number") out.set(e.accountIndex, e);
    return out;
  };
  const pre = own(meta.preTokenBalances);
  const post = own(meta.postTokenBalances);
  const held = (e: TokenBalanceEntry) => {
    const raw = e.uiTokenAmount?.amount;
    return e.mint === WSOL && typeof raw === "string" && /^\d+$/.test(raw) ? BigInt(raw) : 0n;
  };
  let rent = 0n;
  for (const [i, e] of post) {
    const lamports = meta.postBalances?.[i];
    if (!pre.has(i) && typeof lamports === "number") rent += BigInt(lamports) - held(e);
  }
  for (const [i, e] of pre) {
    const lamports = meta.preBalances?.[i];
    if (!post.has(i) && typeof lamports === "number") rent -= BigInt(lamports) - held(e);
  }
  return rent;
}

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
  const total = (entries: TokenBalanceEntry[] | undefined, of: string) => {
    let sum = 0n;
    for (const e of entries ?? []) {
      if (e.owner !== wallet || e.mint !== of) continue;
      const raw = e.uiTokenAmount?.amount;
      if (typeof raw === "string" && /^\d+$/.test(raw)) sum += BigInt(raw);
    }
    return sum;
  };
  // Wrapped SOL is SOL: a sale paid into the wallet's wrapped-SOL account was still paid.
  const lamports =
    (typeof pre === "number" && typeof post === "number" ? BigInt(post) - BigInt(pre) : 0n) +
    total(meta.postTokenBalances, WSOL) -
    total(meta.preTokenBalances, WSOL);
  const tokens = total(meta.postTokenBalances, mint) - total(meta.preTokenBalances, mint);
  if (tokens === 0n) return null;
  const paid = at === 0 ? lamports + tokenAccountRent(meta, wallet) : lamports;
  // Only a transaction the wallet paid for can be its trade; one paid by someone else that moved
  // its tokens was a transfer. And SOL out that is no more than fees is a transfer it paid for.
  // A sale is told by the SOL as it landed (a dust sale's rent back is what shows it was paid).
  const payer = at === 0;
  const side: WalletTrade["side"] =
    tokens > 0n
      ? payer && -paid > FEE_ONLY_LAMPORTS
        ? "buy"
        : "in"
      : payer && lamports > 0n
        ? "sell"
        : "out";
  return { signature, t: tx.blockTime * 1000, side, lamports: paid, tokens };
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
