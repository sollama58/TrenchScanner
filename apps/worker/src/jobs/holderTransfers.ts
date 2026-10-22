import {
  createLogger,
  holderTransfersReading,
  isServiceWallet,
  keysOf,
  linkingTransfers,
  prisma,
  sharedSignatures,
  transferMovesOf,
  type ChainTx,
  type HeliusClient,
  type HolderTransfersReading,
  type TransferMove,
} from "@trenchscanner/core";
import {
  STREAM_SETTLE_MS,
  type HeliusAccountStream,
  type HeliusStreamStats,
} from "../discovery/heliusAccountStream.js";
import {
  applyHolderBalances,
  cachedHolderAccounts,
  cachedTopHolders,
  topHolderWalletsOf,
  type HolderBalanceMove,
} from "./linkedWallets.js";

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
 *
 * With the Helius stream on (HELIUS_HOLDER_STREAM, user ask 2026-10-17: credits), each coin read
 * here also has its holders' accounts followed live (discovery/heliusAccountStream.ts). An account
 * read after its subscription settled is then kept fresh by the stream instead of being read again
 * every ACCOUNT_REREAD_MS, and a transfer between two holders arrives with its transaction, so it
 * needs no getTransaction either. Whatever the stream doesn't cover is read as before.
 *
 * A read only starts an account's cover when it comes after the subscription settled, so a read
 * due while the stream is still confirming or settling the account waits for it (up to
 * STREAM_READ_WAIT_MS): read in the same cycle as the subscribe, every new contender's accounts
 * were read twice, the second time 10 minutes on, before the stream spared anything (audit
 * 2026-10-22, H-4).
 */

/** How long an account's signatures stand before a contender's are read again (newer ones only). */
export const ACCOUNT_REREAD_MS = 10 * 60_000;
/** How long an account read before can still give a reading from the caches. */
export const ACCOUNT_MAX_AGE_MS = 2 * 3_600_000;
/**
 * Longest a due read waits for the stream to confirm and settle its account before it is read
 * anyway: past this, Helius is slow to answer or the cover keeps restarting, and the account is
 * polled as without the stream. A subscription Helius answers at once settles in STREAM_SETTLE_MS,
 * read on the first cycle after.
 */
export const STREAM_READ_WAIT_MS = 3 * STREAM_SETTLE_MS;
const MAX_ACCOUNTS = 25_000;
const MAX_TXS = 50_000;

interface AccountSignatures {
  /** Its successful signatures, each with its block time (ms epoch, null when not known). */
  sigs: Map<string, number | null>;
  /** The newest signature seen, read from next time. */
  newest: string | null;
  atMs: number;
  /** When the timer last had it due: read, or spared by the stream (streamSkipped). */
  dueAtMs: number;
}

/** Each token account's signatures, by its address. */
const accountSigs = new Map<string, AccountSignatures>();
/** Each read transaction's moves of its coin, by "mint:signature"; null when it is not a transfer. */
const txMoves = new Map<string, { atMs: number | null; moves: TransferMove[]; signature: string } | null>();

/**
 * Each account whose due read is waiting for the stream (streamWaits): when it started waiting,
 * and when it was last found waiting.
 */
const waiting = new Map<string, { since: number; seenAt: number }>();

let calls = { getSignaturesForAddress: 0, getTransaction: 0, streamSkipped: 0, streamDeferred: 0 };

type HolderStream = Pick<HeliusAccountStream, "watch" | "coveredSince" | "awaitingCover" | "takeStats">;
let stream: HolderStream | null = null;

/** Hands the module the Helius stream (null turns it off): see the note at the top. */
export function setHolderTransferStream(s: HolderStream | null): void {
  stream = s;
}

/** The stream's counts since the last call, for the scan's heartbeat; null with the stream off. */
export function takeHolderStreamStats(): HeliusStreamStats | null {
  return stream?.takeStats() ?? null;
}

/** Whether the stream has followed `account` (of `mint`) without a break since it was last read. */
function streamCovers(mint: string, account: string, e: AccountSignatures): boolean {
  const since = stream?.coveredSince(mint, account) ?? null;
  return since !== null && e.atMs >= since + STREAM_SETTLE_MS;
}

/**
 * Whether `account`'s due read should wait for the stream: Helius has yet to confirm its
 * subscription, or confirmed it under STREAM_SETTLE_MS ago, so a read now would not start its
 * cover (streamCovers) and would have to be made again. Never once the account has waited
 * STREAM_READ_WAIT_MS, nor while the stream is off, disconnected, or turned the coin away (capped
 * or refused): then the account is read as before.
 */
function streamWaits(mint: string, account: string, now: number): boolean {
  if (!stream) return false;
  const since = stream.coveredSince(mint, account, now);
  const pending = since !== null ? now < since + STREAM_SETTLE_MS : stream.awaitingCover(mint, account, now);
  if (!pending) {
    waiting.delete(account);
    return false;
  }
  const w = waiting.get(account);
  // A wait not seen for ACCOUNT_REREAD_MS is an old one (the coin left and came back). Shorter, and
  // a slow cycle would start the wait afresh every time and never read.
  if (!w || now - w.seenAt > ACCOUNT_REREAD_MS) {
    waiting.delete(account);
    waiting.set(account, { since: now, seenAt: now });
    if (waiting.size > MAX_ACCOUNTS) {
      const oldest = waiting.keys().next().value;
      if (oldest !== undefined) waiting.delete(oldest);
    }
    return true;
  }
  if (now - w.since >= STREAM_READ_WAIT_MS) {
    waiting.delete(account);
    return false;
  }
  w.seenAt = now;
  return true;
}

/**
 * A transaction the stream delivered for `mint`'s holder accounts: its signature goes on each
 * account's list (and moves that account's read point only when the stream covers it, so a gap
 * is still read), and its moves of the coin are kept when it touched two or more of them.
 */
export function onHolderStreamTx(mint: string, signature: string, tx: ChainTx, nowMs = Date.now()): void {
  if (tx.meta?.err) return;
  // The holders' new balances land on the coin's top-holder list now (user ask 2026-10-19).
  applyHolderBalances(mint, balanceMovesOf(mint, tx), nowMs, signature);
  let touched = 0;
  for (const address of new Set(keysOf(tx))) {
    const e = accountSigs.get(address);
    if (!e) continue;
    touched += 1;
    e.sigs.set(signature, nowMs);
    if (streamCovers(mint, address, e)) {
      e.newest = signature;
      e.atMs = nowMs;
    }
  }
  const key = `${mint}:${signature}`;
  if (touched >= 2 && !txMoves.has(key)) {
    const moves = transferMovesOf(mint, tx);
    rememberMoves(key, moves ? { atMs: nowMs, moves, signature } : null);
  }
}

type StreamBalance = {
  accountIndex: number;
  mint?: string;
  owner?: string;
  uiTokenAmount?: { amount?: string };
};

/** Each token account of `mint` a transaction moved: its owner and raw balance before and after. */
export function balanceMovesOf(mint: string, tx: ChainTx): HolderBalanceMove[] {
  const keys = keysOf(tx);
  const byAccount = new Map<string, HolderBalanceMove>();
  const amount = (b: StreamBalance) => {
    const a = b.uiTokenAmount?.amount;
    return typeof a === "string" && /^\d+$/.test(a) ? BigInt(a) : 0n;
  };
  const collect = (list: unknown, side: "pre" | "post") => {
    for (const b of (list ?? []) as StreamBalance[]) {
      const account = keys[b.accountIndex];
      if (b.mint !== mint || !account || !b.owner) continue;
      const m = byAccount.get(account) ?? { account, owner: b.owner, pre: 0n, post: 0n };
      m[side] = amount(b);
      byAccount.set(account, m);
    }
  };
  collect(tx.meta?.preTokenBalances, "pre");
  collect(tx.meta?.postTokenBalances, "post");
  return [...byAccount.values()].filter((m) => m.pre !== m.post);
}

/**
 * Whether the stream has followed every one of a coin's holder accounts since before its list was
 * read at `listAtMs` (with STREAM_SETTLE_MS to spare): every balance move since is then on the
 * list (applyHolderBalances), and only a wallet buying in from outside it needs a read.
 */
export function holderListStreamed(g: TransferGroup, listAtMs: number, nowMs = Date.now()): boolean {
  if (!stream) return false;
  const h = holdersOf(g, nowMs);
  if (!h) return false;
  for (const accounts of h.accountsOf.values())
    for (const a of accounts) {
      const since = stream.coveredSince(g.mintAddress, a, nowMs);
      if (since === null || listAtMs < since + STREAM_SETTLE_MS) return false;
    }
  return true;
}

/**
 * Calls since the last call, for the scan's heartbeat: 1 credit each. With them, the reads the
 * stream spared (streamSkipped: one an account each ACCOUNT_REREAD_MS its cover stood in, a credit
 * each) and the due reads held back for it to settle (streamDeferred, counted each cycle one waits).
 */
export function takeHolderTransferStats(): {
  getSignaturesForAddress: number;
  getTransaction: number;
  streamSkipped: number;
  streamDeferred: number;
  credits: number;
} {
  const out = { ...calls, credits: calls.getSignaturesForAddress + calls.getTransaction };
  calls = { getSignaturesForAddress: 0, getTransaction: 0, streamSkipped: 0, streamDeferred: 0 };
  return out;
}

/** Test hook. */
export function resetHolderTransfers(): void {
  stream = null;
  accountSigs.clear();
  txMoves.clear();
  waiting.clear();
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
 * `maxTxReads` (a coin left part-read finishes on a later cycle). An account the stream is about
 * to cover waits for it (streamWaits) and leaves the budget to the next coin. Answers how many of
 * each it sent, so a caller reading in several passes can hold them all to one budget. Never rejects.
 */
export async function resolveHolderTransfers(
  groups: readonly TransferGroup[],
  helius: Pick<HeliusClient, "getAccountSignaturesBatch" | "getTransactionsBatch">,
  opts: { maxSignatureReads: number; maxTxReads: number; nowMs?: number },
): Promise<{ signatureReads: number; txReads: number }> {
  const now = opts.nowMs ?? Date.now();
  const read = groups.flatMap((g) => {
    const h = holdersOf(g, now);
    return h ? [{ g, h }] : [];
  });
  if (read.length === 0) return { signatureReads: 0, txReads: 0 };

  // Signatures, a whole coin at a time.
  const due: { address: string; until: string | null }[] = [];
  const queued = new Set<string>();
  for (const { g, h } of read) {
    const all = [...new Set([...h.accountsOf.values()].flat())];
    stream?.watch(g.mintAddress, all, now);
    const accounts = all.filter((a) => {
      if (queued.has(a)) return false;
      const e = accountSigs.get(a);
      if (e && streamCovers(g.mintAddress, a, e)) {
        e.atMs = now;
        if (now - e.dueAtMs >= ACCOUNT_REREAD_MS) {
          e.dueAtMs = now;
          calls.streamSkipped += 1;
        }
        return false;
      }
      if (e && now - e.atMs < ACCOUNT_REREAD_MS) return false;
      // Due. Read once the stream's cover has settled, that read starts it, and no re-read follows.
      if (streamWaits(g.mintAddress, a, now)) {
        calls.streamDeferred += 1;
        return false;
      }
      return true;
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
          dueAtMs: now,
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
  const spent = { signatureReads: due.length, txReads: wanted.size };
  if (wanted.size === 0) return spent;
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
  return spent;
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
    const linking = linkingTransfers(reading.events, pctOf, (w) => hot(w) || isServiceWallet(w));
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
