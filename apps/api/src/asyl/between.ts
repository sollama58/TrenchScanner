import {
  prisma,
  flowsFromTransactions,
  heliusCreditsOut,
  type Env,
  type HeliusClient,
} from "@trenchscanner/core";
import { metered, type Chained } from "./chain.js";

/**
 * Transfers between wallets (user ask 2026-10-28: "select two or more wallets, and see every
 * historical transfer between them"): each SOL or coin move from one wallet of the set to another,
 * one row a transaction, newest first.
 *
 * Free, from the tables: holder transfers between top holders (HolderTransferEvent, 30 days) and
 * who paid each wallet its first SOL (WalletFunder). Pro Mode reads the chain as well, against the
 * reader's Asyl allowance: each wallet's signatures, its token accounts' included (1,000 a page for
 * 10 credits), matched across the set, so a transaction two of them share is found without reading
 * any other; then only the shared ones are read in full (1 credit each) and read for moves between
 * the set (core's flowsFromTransactions, one transaction at a time). A read is kept for a day, for
 * everyone, so asking again for the same set is free.
 */

/** Wallets read together at most. */
export const BETWEEN_WALLETS_MAX = 6;
/** Signature pages read per wallet (1,000 each, 10 credits): 5,000 transactions back at most. */
export const BETWEEN_SIG_PAGES = 5;
/** Shared transactions read in full at most, newest first (1 credit each). */
export const BETWEEN_SHARED_MAX = 200;
/** Credits a signature page and a full transaction take. */
const PAGE_CREDITS = 10;
const TX_CREDITS = 1;
/** Rows answered at most. */
export const BETWEEN_ROWS_MAX = 500;
/** A chain read is kept and shared this long. */
export const BETWEEN_TTL_MS = 24 * 3_600_000;

/** The most a chain read of `n` wallets may take. */
export const betweenWorst = (n: number) =>
  n * BETWEEN_SIG_PAGES * PAGE_CREDITS + BETWEEN_SHARED_MAX * TX_CREDITS;
/** The least it needs to start: a page for each wallet, and a few transactions. */
export const betweenMin = (n: number) => n * PAGE_CREDITS + 10 * TX_CREDITS;

export interface BetweenTransfer {
  /** The transaction, when known (a stored first funding has none). */
  signature: string | null;
  /** ms; null when the chain gave no time. */
  at: number | null;
  from: string;
  to: string;
  /** Null for SOL. */
  mint: string | null;
  /** SOL moved, or whole coins moved; null when only the share of supply is known. */
  amount: number | null;
  /** % of the coin's supply it moved, for a stored holder transfer. */
  pct: number | null;
  /** "funding": the wallet's first SOL, as TrenchScanner read it. */
  kind: "transfer" | "funding";
  source: "stored" | "chain";
}

export interface BetweenWalletCover {
  wallet: string;
  /** Transactions of its own the read listed. */
  txs: number;
  /** Its whole history was listed. */
  complete: boolean;
  /** The oldest one listed (ms). */
  fromMs: number | null;
}

/** How far a chain read went. "allowance": the reader's credits ran short of reading further. */
export type BetweenStop = "done" | "limit" | "allowance" | "paused";

export interface BetweenChain {
  covers: BetweenWalletCover[];
  /** Transactions two or more of the wallets share, and how many of those were read in full. */
  shared: number;
  read: number;
  stop: BetweenStop;
  readAt: number;
}

export interface BetweenCoin {
  mint: string;
  symbol: string | null;
  name: string | null;
  image: string | null;
}

export interface BetweenRead {
  wallets: string[];
  transfers: BetweenTransfer[];
  /** More rows were found than BETWEEN_ROWS_MAX. */
  more: boolean;
  coins: BetweenCoin[];
  /** The chain read behind the chain rows, when one ran or was kept. */
  chain: BetweenChain | null;
}

const keyOf = (wallets: readonly string[]) => [...new Set(wallets)].sort().join(",");

/** What the tables know: holder transfers and first fundings between the wallets. */
export async function storedBetween(wallets: readonly string[]): Promise<BetweenTransfer[]> {
  const set = [...new Set(wallets)];
  const [moves, funders] = await Promise.all([
    prisma.holderTransferEvent.findMany({
      where: { fromWallet: { in: set }, toWallet: { in: set } },
      orderBy: { at: "desc" },
      take: BETWEEN_ROWS_MAX,
    }),
    prisma.walletFunder.findMany({
      where: { wallet: { in: set }, funder: { in: set } },
      select: { wallet: true, funder: true, amountSol: true, fundedAt: true },
    }),
  ]);
  const out: BetweenTransfer[] = moves
    .filter((m) => m.fromWallet !== m.toWallet)
    .map((m) => ({
      signature: m.signature,
      at: m.at.getTime(),
      from: m.fromWallet,
      to: m.toWallet,
      mint: m.mintAddress,
      amount: null,
      pct: m.pct,
      kind: "transfer",
      source: "stored",
    }));
  for (const f of funders) {
    if (!f.funder || f.funder === f.wallet) continue;
    out.push({
      signature: null,
      at: f.fundedAt?.getTime() ?? null,
      from: f.funder,
      to: f.wallet,
      mint: null,
      amount: f.amountSol,
      pct: null,
      kind: "funding",
      source: "stored",
    });
  }
  return out;
}

/** Moves between `wallets` in one transaction, each counted once, from its sender's side. */
export function movesIn(
  tx: Parameters<typeof flowsFromTransactions>[1][number],
  signature: string,
  wallets: readonly string[],
  walletCheck?: (address: string) => boolean,
): BetweenTransfer[] {
  const set = new Set(wallets);
  const at = typeof tx.blockTime === "number" ? tx.blockTime * 1000 : null;
  const out: BetweenTransfer[] = [];
  for (const w of set) {
    const flows = flowsFromTransactions(w, [tx], walletCheck);
    for (const t of flows.transfers) {
      if (t.dir !== "out" || !set.has(t.counterparty) || t.counterparty === w) continue;
      out.push({
        signature,
        at,
        from: w,
        to: t.counterparty,
        mint: t.mint,
        amount: t.amount,
        pct: null,
        kind: "transfer",
        source: "chain",
      });
    }
  }
  return out;
}

/** Signatures listed per wallet, kept a little while so a set that grows reads only the new one. */
const SIG_TTL_MS = 3_600_000;
const sigLists = new Map<string, { at: number; sigs: Map<string, number | null>; complete: boolean }>();
const SIG_LISTS_MAX = 40;
/** Chain reads kept, by the sorted set of wallets. */
const chainReads = new Map<string, { at: number; transfers: BetweenTransfer[]; chain: BetweenChain }>();
const CHAIN_READS_MAX = 200;

/** Clears what is kept in memory: for tests. */
export function clearBetweenCache(): void {
  sigLists.clear();
  chainReads.clear();
}

function keptChain(wallets: readonly string[], now: number) {
  const hit = chainReads.get(keyOf(wallets));
  return hit && now - hit.at < BETWEEN_TTL_MS ? hit : null;
}

type BetweenHelius = Pick<HeliusClient, "getWalletSignaturesPage" | "getTransactionsBatch">;

/** The chain read itself, spending no more than `budget` credits. */
export async function readBetweenChain(
  helius: BetweenHelius,
  wallets: readonly string[],
  budget: number,
  now = Date.now(),
): Promise<{ transfers: BetweenTransfer[]; chain: BetweenChain; asked: boolean } | null> {
  const set = [...new Set(wallets)];
  let spent = 0;
  let asked = false;
  let stop: BetweenStop = "done";
  const cut = (why: BetweenStop) => {
    // The worse reason wins: a read short of credits says so over one that reached the limit.
    if (stop === "done" || (stop === "limit" && why !== "limit")) stop = why;
  };
  let unread = 0;
  const lists = new Map<string, { sigs: Map<string, number | null>; complete: boolean }>();
  for (const w of set) {
    const kept = sigLists.get(w);
    if (kept && now - kept.at < SIG_TTL_MS) {
      lists.set(w, kept);
      continue;
    }
    const sigs = new Map<string, number | null>();
    let token: string | undefined;
    let complete = false;
    let whole = true;
    for (let page = 0; page < BETWEEN_SIG_PAGES; page++) {
      if (heliusCreditsOut()) {
        cut("paused");
        whole = false;
        break;
      }
      // A wallet's first page always goes, the read's least; later pages leave room for a few
      // shared transactions.
      if (spent + PAGE_CREDITS > budget - (page === 0 ? 0 : 10 * TX_CREDITS)) {
        cut("allowance");
        whole = false;
        break;
      }
      const res = await helius.getWalletSignaturesPage(w, token ? { paginationToken: token } : {});
      spent += PAGE_CREDITS;
      asked = true;
      if (res.status !== "ok") {
        if (page === 0) unread += 1;
        whole = false;
        break;
      }
      for (const s of res.sigs) sigs.set(s.signature, s.at);
      if (!res.paginationToken) {
        complete = true;
        break;
      }
      token = res.paginationToken;
      if (page === BETWEEN_SIG_PAGES - 1) cut("limit");
    }
    const list = { sigs, complete };
    lists.set(w, list);
    // A list cut short by credits or a failed page is read again next time.
    if (whole) {
      if (sigLists.size >= SIG_LISTS_MAX) sigLists.delete(sigLists.keys().next().value!);
      sigLists.set(w, { at: now, ...list });
    }
  }
  // Not one wallet could be listed: no answer, rather than "no transfers".
  if (unread > 0 && unread >= set.length - 1) return null;

  // A transaction two or more of them list.
  const seen = new Map<string, { n: number; at: number | null }>();
  for (const l of lists.values())
    for (const [sig, at] of l.sigs) {
      const s = seen.get(sig);
      seen.set(sig, { n: (s?.n ?? 0) + 1, at: s?.at ?? at });
    }
  const shared = [...seen].filter(([, s]) => s.n >= 2).sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0));
  const room = Math.max(0, Math.floor((budget - spent) / TX_CREDITS));
  const take = shared.slice(0, Math.min(BETWEEN_SHARED_MAX, room)).map(([sig]) => sig);
  if (take.length < shared.length) cut(take.length < BETWEEN_SHARED_MAX ? "allowance" : "limit");
  const transfers: BetweenTransfer[] = [];
  let read = 0;
  if (take.length > 0 && heliusCreditsOut()) cut("paused");
  else if (take.length > 0) {
    const txs = await helius.getTransactionsBatch(take);
    asked = true;
    for (const sig of take) {
      const tx = txs.get(sig);
      if (!tx || tx === "failed") continue;
      read += 1;
      transfers.push(...movesIn(tx, sig, set));
    }
  }

  const chain: BetweenChain = {
    covers: set.map((w) => {
      const l = lists.get(w);
      let fromMs: number | null = null;
      for (const at of l?.sigs.values() ?? [])
        if (at !== null) fromMs = fromMs === null ? at : Math.min(fromMs, at);
      return { wallet: w, txs: l?.sigs.size ?? 0, complete: l?.complete ?? false, fromMs };
    }),
    shared: shared.length,
    read,
    stop,
    readAt: now,
  };
  // Kept only when it went as far as a read can: one cut short by the allowance is read again.
  if (stop === "done" || stop === "limit") {
    if (chainReads.size >= CHAIN_READS_MAX) chainReads.delete(chainReads.keys().next().value!);
    chainReads.set(keyOf(set), { at: now, transfers, chain });
  }
  return { transfers, chain, asked };
}

/** Pro: the chain read, metered against the reader's allowance; a kept read is free. */
export function meteredBetween(
  env: Env,
  helius: BetweenHelius,
  userId: string,
  wallets: readonly string[],
  now = Date.now(),
): Promise<Chained<{ transfers: BetweenTransfer[]; chain: BetweenChain }>> {
  const n = new Set(wallets).size;
  return metered(
    env,
    userId,
    { min: betweenMin(n), max: betweenWorst(n) },
    async (before) => {
      const r = await readBetweenChain(helius, wallets, before.left, now);
      return r ? { value: { transfers: r.transfers, chain: r.chain }, cached: !r.asked } : null;
    },
    async () => {
      const hit = keptChain(wallets, now);
      return hit ? { transfers: hit.transfers, chain: hit.chain } : null;
    },
  );
}

/** Stored and chain rows as one list: a transaction both have is shown once, as the chain read it. */
export function mergeBetween(stored: BetweenTransfer[], chain: BetweenTransfer[]): BetweenTransfer[] {
  const fromChain = new Set(chain.map((t) => `${t.signature}|${t.from}|${t.to}|${t.mint ?? ""}`));
  const chainFunded = new Set(chain.filter((t) => t.mint === null).map((t) => `${t.from}|${t.to}`));
  const kept = stored.filter((t) =>
    t.kind === "funding"
      ? // A first funding the chain read found as a transfer at about the same time is that transfer.
        !(
          chainFunded.has(`${t.from}|${t.to}`) &&
          chain.some(
            (c) =>
              c.mint === null &&
              c.from === t.from &&
              c.to === t.to &&
              c.at !== null &&
              t.at !== null &&
              Math.abs(c.at - t.at) < 60_000,
          )
        )
      : !fromChain.has(`${t.signature}|${t.from}|${t.to}|${t.mint ?? ""}`),
  );
  return [...kept, ...chain].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

/** The coins the rows name, for their symbols and images. */
export async function coinsOf(transfers: readonly BetweenTransfer[]): Promise<BetweenCoin[]> {
  const mints = [...new Set(transfers.map((t) => t.mint).filter((m): m is string => !!m))];
  if (mints.length === 0) return [];
  const rows = await prisma.token.findMany({
    where: { mintAddress: { in: mints } },
    select: { mintAddress: true, symbol: true, name: true, imageUrl: true },
  });
  return rows.map((r) => ({ mint: r.mintAddress, symbol: r.symbol, name: r.name, image: r.imageUrl }));
}

/** The answer: stored rows, with a chain read's when one is given, and their coins. */
export async function betweenRead(
  wallets: readonly string[],
  chain: { transfers: BetweenTransfer[]; chain: BetweenChain } | null,
): Promise<BetweenRead> {
  const set = [...new Set(wallets)];
  const all = mergeBetween(await storedBetween(set), chain?.transfers ?? []);
  const transfers = all.slice(0, BETWEEN_ROWS_MAX);
  return {
    wallets: set,
    transfers,
    more: all.length > transfers.length,
    coins: await coinsOf(transfers),
    chain: chain?.chain ?? null,
  };
}

/** A kept chain read for this set, free, when there is one. */
export function keptBetween(wallets: readonly string[], now = Date.now()) {
  const hit = keptChain(wallets, now);
  return hit ? { transfers: hit.transfers, chain: hit.chain } : null;
}
