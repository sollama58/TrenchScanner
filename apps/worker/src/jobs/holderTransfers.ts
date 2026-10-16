import {
  createLogger,
  holderTransfersReading,
  KNOWN_EXCHANGE_WALLETS,
  linkingTransfers,
  prisma,
  sharedSignatures,
  transferMovesOf,
  type HeliusClient,
  type HolderTransfersReading,
  type TransferMove,
} from "@trenchscanner/core";
import { cachedHolderAccounts, cachedTopHolders, topHolderWalletsOf } from "./linkedWallets.js";

const logger = createLogger("holder-transfers");

/**
 * Holder-to-holder transfers (user ask 2026-10-16, core's wallets/holderTransfers.ts): which of a
 * coin's top 25 holders (and its creator, when it holds) sent the coin to, or got it from, another.
 *
 * A transfer between two holders touches both of their token accounts, so its signature is in
 * both accounts' lists. Each holder's token accounts come with the top-holder read (no extra
 * call); each account's signatures are one 1-credit call, and only the signatures two holders
 * share are read in full (getTransaction, 1 credit each). So a coin's first read is about 25
 * credits plus one per shared transaction, and a re-read asks only for signatures newer than the
 * last one seen, 1 credit an account.
 *
 * Read for the coins about to be decided on (the contenders, and alerts held for a wallet figure),
 * on its own per-cycle budget; every other coin gets a reading from the caches alone, so a coin
 * keeps its links on later scans while its holders stay the same. Display and a recorded stat
 * only: no filter, safety screen, Linked count or model reads it.
 */

/** How long an account's signatures stand before a contender's are read again (newer ones only). */
export const ACCOUNT_REREAD_MS = 10 * 60_000;
/** How long an account read before can still give a reading from the caches. */
export const ACCOUNT_MAX_AGE_MS = 2 * 3_600_000;
const MAX_ACCOUNTS = 25_000;
const MAX_TXS = 50_000;

interface AccountSignatures {
  /** Its successful signatures, each with its block time (ms epoch, null when not known). */
  sigs: Map<string, number | null>;
  /** The newest signature seen, read from next time. */
  newest: string | null;
  atMs: number;
}

/** Each token account's signatures, by its address. */
const accountSigs = new Map<string, AccountSignatures>();
/** Each read transaction's moves of its coin, by "mint:signature"; null when it is not a transfer. */
const txMoves = new Map<string, { atMs: number | null; moves: TransferMove[]; signature: string } | null>();

let calls = { getSignaturesForAddress: 0, getTransaction: 0 };

/** Calls since the last call, for the scan's heartbeat: 1 credit each. */
export function takeHolderTransferStats(): {
  getSignaturesForAddress: number;
  getTransaction: number;
  credits: number;
} {
  const out = { ...calls, credits: calls.getSignaturesForAddress + calls.getTransaction };
  calls = { getSignaturesForAddress: 0, getTransaction: 0 };
  return out;
}

/** Test hook. */
export function resetHolderTransfers(): void {
  accountSigs.clear();
  txMoves.clear();
  takeHolderTransferStats();
}

export interface TransferGroup {
  mintAddress: string;
  creator?: string | null;
}

/**
 * The holders a coin's reading is over, each with its token accounts, and the coin's raw supply:
 * the top 25 the Linked count reads (pools and the creator aside), and the creator when it is
 * among the largest holders read. Undefined until the chain's list (with its accounts) is in.
 */
function holdersOf(
  g: TransferGroup,
  nowMs: number,
): { owners: string[]; accountsOf: Map<string, readonly string[]>; supply: bigint } | undefined {
  const wallets = topHolderWalletsOf(g.mintAddress, g.creator, nowMs);
  const read = cachedHolderAccounts(g.mintAddress, nowMs);
  if (!wallets || !read) return undefined;
  const owners = [...wallets];
  const creator = g.creator ?? null;
  if (creator && cachedTopHolders(g.mintAddress, nowMs)?.some((h) => h.owner === creator))
    owners.push(creator);
  const accountsOf = new Map<string, readonly string[]>();
  for (const o of owners) {
    const accounts = read.accountsOf.get(o);
    // A holder whose accounts the read didn't list: the reading would miss its transfers.
    if (!accounts?.length) return undefined;
    accountsOf.set(o, accounts);
  }
  return { owners, accountsOf, supply: read.supply };
}

/**
 * Reads what the groups' readings still need, in their order (contenders first): each holder
 * account never read, or read more than ACCOUNT_REREAD_MS ago (only its newer signatures), a whole
 * coin at a time within `maxSignatureReads`; then the shared transactions not yet read, up to
 * `maxTxReads` (a coin left part-read finishes on a later cycle). Never rejects.
 */
export async function resolveHolderTransfers(
  groups: readonly TransferGroup[],
  helius: Pick<HeliusClient, "getAccountSignaturesBatch" | "getTransactionsBatch">,
  opts: { maxSignatureReads: number; maxTxReads: number; nowMs?: number },
): Promise<void> {
  const now = opts.nowMs ?? Date.now();
  const read = groups.flatMap((g) => {
    const h = holdersOf(g, now);
    return h ? [{ g, h }] : [];
  });
  if (read.length === 0) return;

  // Signatures, a whole coin at a time.
  const due: { address: string; until: string | null }[] = [];
  const queued = new Set<string>();
  for (const { h } of read) {
    const accounts = [...new Set([...h.accountsOf.values()].flat())].filter((a) => {
      if (queued.has(a)) return false;
      const e = accountSigs.get(a);
      return !e || now - e.atMs >= ACCOUNT_REREAD_MS;
    });
    if (accounts.length === 0 || due.length + accounts.length > opts.maxSignatureReads) continue;
    for (const a of accounts) {
      queued.add(a);
      due.push({ address: a, until: accountSigs.get(a)?.newest ?? null });
    }
  }
  if (due.length > 0) {
    try {
      const pages = await helius.getAccountSignaturesBatch(due);
      calls.getSignaturesForAddress += due.length;
      for (const { address } of due) {
        const page = pages.get(address);
        if (!page || page.status !== "found") continue;
        const prev = accountSigs.get(address);
        const sigs = new Map(prev?.sigs ?? []);
        for (const s of page.signatures) if (s.ok) sigs.set(s.signature, s.atMs);
        accountSigs.delete(address);
        accountSigs.set(address, {
          sigs,
          newest: page.signatures[0]?.signature ?? prev?.newest ?? null,
          atMs: now,
        });
        if (accountSigs.size > MAX_ACCOUNTS) {
          const oldest = accountSigs.keys().next().value;
          if (oldest !== undefined) accountSigs.delete(oldest);
        }
      }
    } catch (err) {
      logger.warn("holder signature reads failed", { accounts: due.length, error: String(err) });
    }
  }

  // The transactions two holders share, not read yet, coin by coin until the budget is spent.
  const wanted = new Map<string, { mint: string; atMs: number | null }[]>();
  let txLeft = opts.maxTxReads;
  for (const { g, h } of read) {
    if (txLeft <= 0) break;
    for (const sig of sharedOf(h.accountsOf)) {
      if (txLeft <= 0) break;
      if (txMoves.has(`${g.mintAddress}:${sig}`)) continue;
      const list = wanted.get(sig) ?? [];
      if (list.length === 0) txLeft -= 1;
      list.push({ mint: g.mintAddress, atMs: signatureTime(h.accountsOf, sig) });
      wanted.set(sig, list);
    }
  }
  if (wanted.size === 0) return;
  try {
    const txs = await helius.getTransactionsBatch([...wanted.keys()]);
    calls.getTransaction += wanted.size;
    for (const [sig, uses] of wanted) {
      const tx = txs.get(sig);
      if (tx === undefined || tx === "failed") continue;
      for (const u of uses) {
        const moves = tx ? transferMovesOf(u.mint, tx) : null;
        rememberMoves(`${u.mint}:${sig}`, moves ? { atMs: u.atMs, moves, signature: sig } : null);
      }
    }
  } catch (err) {
    logger.warn("holder transfer transaction reads failed", { txs: wanted.size, error: String(err) });
  }
}

/**
 * A coin's reading from the caches alone, or null while any holder's accounts are unread (or read
 * over ACCOUNT_MAX_AGE_MS ago) or any transaction they share is unread: a part-read list reads low.
 */
export function holderTransfersOf(g: TransferGroup, nowMs = Date.now()): HolderTransfersReading | null {
  const h = holdersOf(g, nowMs);
  if (!h) return null;
  for (const accounts of h.accountsOf.values()) {
    for (const a of accounts) {
      const e = accountSigs.get(a);
      if (!e || nowMs - e.atMs > ACCOUNT_MAX_AGE_MS) return null;
    }
  }
  const moves: { atMs: number | null; moves: TransferMove[]; signature: string }[] = [];
  for (const sig of sharedOf(h.accountsOf)) {
    const m = txMoves.get(`${g.mintAddress}:${sig}`);
    if (m === undefined) return null;
    if (m) moves.push(m);
  }
  return holderTransfersReading(h.owners, moves, h.supply);
}

function sharedOf(accountsOf: ReadonlyMap<string, readonly string[]>): Set<string> {
  return sharedSignatures(accountsOf, (a) => accountSigs.get(a)?.sigs.keys() ?? []);
}

function signatureTime(accountsOf: ReadonlyMap<string, readonly string[]>, sig: string): number | null {
  for (const accounts of accountsOf.values()) {
    for (const a of accounts) {
      const t = accountSigs.get(a)?.sigs.get(sig);
      if (t !== undefined) return t;
    }
  }
  return null;
}

function rememberMoves(
  key: string,
  value: { atMs: number | null; moves: TransferMove[]; signature: string } | null,
): void {
  txMoves.delete(key);
  txMoves.set(key, value);
  if (txMoves.size > MAX_TXS) {
    const oldest = txMoves.keys().next().value;
    if (oldest !== undefined) txMoves.delete(oldest);
  }
}

/** Transfers already stored (signature:from:to), so a coin read every cycle writes each once. */
const recorded = new Set<string>();
const MAX_RECORDED = 100_000;

/**
 * Keeps each transfer that links two top holders (core's linkingTransfers: no dust, no exchange or
 * hot wallet) as a HolderTransferEvent row, for the flags read across coins (the KOL Possible Side
 * and Multi-Wallet-Bundle tiers in core's holderTransfers.ts). `holdersOf`: each coin's linked
 * reading, for its holders' shares. Written behind the cycle: nothing waits on it, and a failed
 * write is tried again next cycle.
 */
export function recordTransferEvents(
  transfersByMint: ReadonlyMap<string, HolderTransfersReading | null>,
  holdersOf: ReadonlyMap<string, { holders: readonly { wallet: string; pct: number }[] } | null>,
  hot: (wallet: string) => boolean,
): void {
  const rows: {
    signature: string;
    fromWallet: string;
    toWallet: string;
    mintAddress: string;
    pct: number;
    at: Date;
  }[] = [];
  for (const [mint, reading] of transfersByMint) {
    const holders = holdersOf.get(mint)?.holders;
    if (!reading?.events?.length || !holders?.length) continue;
    const pctOf = new Map(holders.map((h) => [h.wallet, h.pct]));
    const linking = linkingTransfers(reading.events, pctOf, (w) => hot(w) || KNOWN_EXCHANGE_WALLETS.has(w));
    for (const e of linking) {
      const key = `${e.signature}:${e.from}:${e.to}`;
      if (e.atMs === null || recorded.has(key)) continue;
      rows.push({
        signature: e.signature,
        fromWallet: e.from,
        toWallet: e.to,
        mintAddress: mint,
        pct: Math.round(e.pct * 10_000) / 10_000,
        at: new Date(e.atMs),
      });
    }
  }
  if (rows.length === 0) return;
  void prisma.holderTransferEvent
    .createMany({ data: rows, skipDuplicates: true })
    .then(() => {
      for (const r of rows) recorded.add(`${r.signature}:${r.fromWallet}:${r.toWallet}`);
      while (recorded.size > MAX_RECORDED) {
        const oldest = recorded.values().next().value;
        if (oldest === undefined) break;
        recorded.delete(oldest);
      }
    })
    .catch((err: unknown) =>
      logger.warn("holder transfer events write failed", { rows: rows.length, error: String(err) }),
    );
}
