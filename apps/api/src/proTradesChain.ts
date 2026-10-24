import {
  associatedTokenAddress,
  PROGRAM,
  walletTokenTrades,
  type WalletTrade,
  type WalletTradesRpc,
} from "@trenchscanner/core";
import type { Position, SeenTrade, TradeRow } from "./proTrades.js";

/**
 * The Portfolio and TRADES panel's check against the chain (user report 2026-10-24: positions not
 * updating, PnL off while the token page was right). Their positions are built from the recorded
 * trades (ProTrade), which the stream and the catch-up fill; a trade both missed (a wallet away
 * long enough, a dropped stream) left a position open at a size the wallet no longer holds, and
 * its PnL valued coins long sold. The token page reads the chain on every open, so it was right.
 *
 * Here the coins' balances are read from the wallet's own token accounts (its associated account
 * under each token program, where every swap lands), and a coin whose balance doesn't match what
 * the recorded trades leave is read back from its token account's history, as the token page reads
 * it (walletTokenTrades), and the missing trades are recorded.
 *
 * Credits (Helius): the balances are one getMultipleAccounts per 50 coins (1 credit), kept
 * CHAIN_BALANCE_TTL_MS per wallet; a coin that disagrees costs one getSignaturesForAddress per
 * token program (1 credit each) and a getTransaction (1 credit) per transaction not recorded yet,
 * once per balance it disagrees at.
 */

/** The coins' balances are reused this long per wallet (a recorded trade drops them at once). */
export const CHAIN_BALANCE_TTL_MS = 60_000;
/** Coins read back from their history per look, at most. */
export const HEALS_PER_LOOK = 3;

/** Raw token balance at offset 64 of a token account (both token programs share the layout). */
function accountAmount(data: Uint8Array | null): bigint {
  if (!data || data.length < 72) return 0n;
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).readBigUInt64LE(64);
}

export interface AccountsReader {
  getAccountsData(addresses: string[]): Promise<(Uint8Array | null)[] | null>;
}

/**
 * Each coin's balance in the wallet's associated token accounts (classic and Token-2022 summed),
 * raw units; a missing account is 0. Null when a read failed.
 */
export async function chainBalances(
  rpc: AccountsReader,
  wallet: string,
  mints: readonly string[],
): Promise<Map<string, bigint> | null> {
  const keys = mints.flatMap((mint) => [
    { mint, address: associatedTokenAddress(wallet, mint, PROGRAM.token) },
    { mint, address: associatedTokenAddress(wallet, mint, PROGRAM.token2022) },
  ]);
  const out = new Map<string, bigint>(mints.map((m) => [m, 0n]));
  for (let i = 0; i < keys.length; i += 100) {
    const page = keys.slice(i, i + 100);
    const data = await rpc.getAccountsData(page.map((k) => k.address));
    if (!data || data.length !== page.length) return null;
    page.forEach((k, j) => out.set(k.mint, (out.get(k.mint) ?? 0n) + accountAmount(data[j] ?? null)));
  }
  return out;
}

/**
 * Whether the chain's balance of a coin disagrees with what its recorded latest trade leaves held:
 * by more than 1% of what that trade bought (and a raw unit of rounding). A sold-out trade still
 * holding coins, or an open one holding fewer, missed a trade.
 */
export function chainDisagrees(p: Position, chainRaw: bigint): boolean {
  const scale = 10 ** p.decimals;
  const chain = Number(chainRaw) / scale;
  const slack = Math.max(p.bought * 0.01, 1 / scale);
  if (p.closed) return chain > slack;
  return Math.abs(chain - p.held) > slack;
}

/** The trades a coin's history read found that aren't recorded yet, as the watcher records them. */
export function missingTrades(
  read: readonly WalletTrade[],
  recorded: ReadonlySet<string>,
  mint: string,
  decimals: number,
): SeenTrade[] {
  return read.flatMap((t): SeenTrade[] => {
    // Coins in with nothing paid aren't trades (walletSwaps leaves them out too).
    if (recorded.has(t.signature) || t.side === "in") return [];
    return [
      {
        signature: t.signature,
        mint,
        side: t.side,
        lamports: t.side === "out" ? null : t.lamports,
        tokens: t.tokens,
        decimals,
        at: new Date(t.t),
      },
    ];
  });
}

/**
 * Reads `mint`'s trades back from the wallet's token accounts, skipping the transactions already
 * recorded (`rows`, that coin's), and returns the ones that aren't. Null when the chain couldn't
 * be read.
 */
export async function readMissingTrades(
  rpc: WalletTradesRpc,
  wallet: string,
  mint: string,
  rows: readonly Pick<TradeRow, "signature" | "decimals">[],
  decimals: number,
): Promise<SeenTrade[] | null> {
  const recorded = new Set(rows.map((r) => r.signature));
  // The recorded ones are known: walletTokenTrades doesn't read a transaction it has a reading for.
  const cache = new Map<string, WalletTrade | null>(
    [...recorded].map((s) => [`${wallet}:${mint}:${s}`, null]),
  );
  const read = await walletTokenTrades(rpc, wallet, mint, cache);
  if (!read) return null;
  return missingTrades(read.trades, recorded, mint, decimals);
}
