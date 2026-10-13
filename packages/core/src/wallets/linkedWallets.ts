import { keysOf, type ChainTx } from "./tradeTape.js";

/**
 * Linked wallets: top holders that one wallet paid for. A wallet's first transaction is almost
 * always the SOL that opened it, and whoever paid for it is its funder. Holders sharing a funder,
 * or one holder having funded another, are one cluster: four wallets from one funder holding 31%
 * reads as one holder with 31%, which the top-10 figure alone hides. The brief:
 * notes/hit-catch-2026-10-13/wallet-risk-brief.md, item 3. apps/worker/src/jobs/linkedWallets.ts
 * does the reading and caching; this file is the pure half.
 *
 * Exchanges and payout services fund thousands of wallets a day, and a shared exchange withdrawal
 * links nothing. Those funders are left out: a short list of known exchange hot wallets, plus any
 * funder that is plainly a service (isHotFunder).
 */

const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Exchange hot wallets known to fund wallets in bulk. Not exhaustive: the busy-funder rules
 * (isHotFunder) catch the rest. A wrong entry only stops links through that one address.
 */
export const HOT_FUNDER_DENYLIST: ReadonlySet<string> = new Set([
  // Binance
  "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9",
  "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
  // Coinbase
  "H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS",
  "2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm",
  "GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE",
  // OKX
  "5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD",
  "is6MTRHEgyFLNTfYcuV4QBWLjrZBfmhVNYR6ccgr8KV",
  // Bybit
  "AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2",
  // Kraken
  "FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5",
  // MEXC
  "ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ",
  // Gate
  "u6PJ8DtQuPFnfmwHbGFULQ4u4EgjDiyYKjVEsynXq2w",
  // KuCoin
  "BmFdpraQhkiDQE6SnfG5omcA1VwzqfXrwtNYBwWTymy6",
]);

/**
 * A funder whose newest page of signatures (SIGNATURES_PAGE, one 1-credit call) all fall within
 * this window sends a thousand transactions a day or more: an exchange, a bridge or a payout bot.
 */
export const HOT_FUNDER_WINDOW_MS = 24 * 3_600_000;
/** A funder seen paying for more than this many of the wallets we read within a day is a service too. */
export const HOT_FUNDER_MAX_FUNDED_24H = 50;
/** Smallest funding transfer that counts: below it, a dust airdrop is not who paid for the wallet. */
export const MIN_FUNDING_SOL = 0.001;

/**
 * The funder in one transaction: whoever's SOL paid the wallet in it. The fee payer, when that is
 * someone else (a plain transfer, or a program call a bot signs); else the account whose balance
 * fell the most while the wallet's rose. Null when the wallet gained less than MIN_FUNDING_SOL, or
 * nobody else paid in (a transaction the provider gave without balances, say).
 */
export function funderFromFirstTransaction(
  wallet: string,
  tx: ChainTx & { blockTime?: number | null },
): { funder: string; amountSol: number; atMs: number | null } | null {
  const keys = keysOf(tx);
  const pre = tx.meta?.preBalances ?? null;
  const post = tx.meta?.postBalances ?? null;
  const at = tx.blockTime;
  const atMs = typeof at === "number" ? at * 1000 : null;
  if (!pre || !post || keys.length === 0) return null;
  const self = keys.indexOf(wallet);
  if (self < 0) return null;
  const received = ((post[self] ?? 0) - (pre[self] ?? 0)) / LAMPORTS_PER_SOL;
  if (received < MIN_FUNDING_SOL) return null;
  const payer = keys[0];
  if (payer && payer !== wallet) return { funder: payer, amountSol: received, atMs };
  const best = biggestSender(keys, pre, post, self);
  return best ? { funder: best.key, amountSol: received, atMs } : null;
}

/** The account whose SOL fell the most in a transaction, the wallet at `self` aside. */
function biggestSender(
  keys: readonly string[],
  pre: readonly number[],
  post: readonly number[],
  self: number,
): { key: string; drop: number } | null {
  let best: { key: string; drop: number } | null = null;
  for (let i = 0; i < keys.length; i += 1) {
    if (i === self || !keys[i]) continue;
    const drop = ((pre[i] ?? 0) - (post[i] ?? 0)) / LAMPORTS_PER_SOL;
    if (drop >= MIN_FUNDING_SOL && (!best || drop > best.drop)) best = { key: keys[i]!, drop };
  }
  return best;
}

/** How many of a wallet's oldest transactions the funder read walks before giving up. */
export const FUNDER_TXS_WALKED = 4;

/**
 * A wallet's funder from its oldest transactions, oldest first: the first one that paid SOL into
 * it. A wallet's first transaction is often not its funding: someone opening a token account for
 * it (an exchange's token withdrawal, a sender's airdrop) moves no SOL, and the SOL arrives a
 * transaction or two later. The walk stops at the first transaction the wallet signed itself: by
 * then it is spending its own SOL, and SOL coming in from then on is a trade, not its funding. That
 * one transaction still names a funder when it is a plain transfer in (one account sent what the
 * wallet received: a claim or withdrawal it signed while someone else paid the fee); its fee payer
 * never does, as that is only a relayer sponsoring the fee.
 *
 * `decided`: whether the answer is final. False only when every transaction given was walked
 * without finding the funding or the wallet's own first signature: the next ones may hold it.
 */
export function funderFromEarliestTransactions(
  wallet: string,
  txs: readonly (ChainTx & { blockTime?: number | null })[],
): { found: { funder: string; amountSol: number; atMs: number | null } | null; decided: boolean } {
  for (const tx of txs) {
    if (tx.meta?.err) continue;
    if (!signedBy(tx, wallet)) {
      const found = funderFromFirstTransaction(wallet, tx);
      if (found) return { found, decided: true };
      continue;
    }
    return { found: transferIn(wallet, tx), decided: true };
  }
  return { found: null, decided: false };
}

/** A plain transfer into the wallet: the one account whose SOL fell by what the wallet received. */
function transferIn(
  wallet: string,
  tx: ChainTx & { blockTime?: number | null },
): { funder: string; amountSol: number; atMs: number | null } | null {
  const keys = keysOf(tx);
  const pre = tx.meta?.preBalances ?? null;
  const post = tx.meta?.postBalances ?? null;
  const self = keys.indexOf(wallet);
  if (!pre || !post || self < 0) return null;
  const received = ((post[self] ?? 0) - (pre[self] ?? 0)) / LAMPORTS_PER_SOL;
  if (received < MIN_FUNDING_SOL) return null;
  const best = biggestSender(keys, pre, post, self);
  // Within a hundredth (rent and fees aside): more out than in is a swap's pool, not a sender.
  if (!best || Math.abs(best.drop - received) > Math.max(0.01 * received, 0.003)) return null;
  const at = tx.blockTime;
  return { funder: best.key, amountSol: received, atMs: typeof at === "number" ? at * 1000 : null };
}

/** Whether the wallet signed the transaction (a signer key; signers come first in the key list). */
function signedBy(tx: ChainTx, wallet: string): boolean {
  const keys = keysOf(tx);
  const i = keys.indexOf(wallet);
  if (i < 0) return false;
  const signers = tx.transaction?.message?.header?.numRequiredSignatures;
  return typeof signers === "number" ? i < signers : i === 0;
}

/**
 * Whether a funder is a service rather than a person: on the denylist, its newest full page of
 * signatures all within a day (`fullPageSpanMs`, null when the page was not full), or seen funding
 * more than HOT_FUNDER_MAX_FUNDED_24H of the wallets we read within a day.
 */
export function isHotFunder(
  funder: string,
  facts: { fullPageSpanMs: number | null; fundedLast24h?: number },
): boolean {
  if (HOT_FUNDER_DENYLIST.has(funder)) return true;
  if (facts.fullPageSpanMs !== null && facts.fullPageSpanMs <= HOT_FUNDER_WINDOW_MS) return true;
  return (facts.fundedLast24h ?? 0) > HOT_FUNDER_MAX_FUNDED_24H;
}

export interface LinkedCluster {
  /** The shared funder; for a pair where one holder funded the other, that holder. */
  funder: string;
  /** Holders in the cluster, largest first. */
  wallets: { wallet: string; pct: number }[];
  /** Their combined share of the supply, %. */
  pct: number;
  /** Tied to the creator: funded by it, it funded them, or the same funder. */
  creatorLinked: boolean;
}

export interface LinkedWalletsReading {
  /** % of supply held by top holders in any cluster. */
  linkedWalletPct: number;
  /** Clusters of two or more holders. */
  linkedClusterCount: number;
  /** The largest cluster's share of supply, %. 0 with no cluster. */
  linkedLargestClusterPct: number;
  /** % of supply held by holders tied to the creator (the creator's own holding aside). */
  linkedCreatorPct: number;
  /** How many holders the reading covers. */
  linkedWalletsChecked: number;
  clusters: LinkedCluster[];
  /** Every holder the reading covers (the creator aside) and its share, %, largest first: the bubble map's bubbles. */
  holders: { wallet: string; pct: number }[];
}

/**
 * Who among `holders` is linked, from each holder's funder. `funderOf` maps a wallet to its funder,
 * to null when it has none we could read (a busy wallet, or one opened by a token transfer), and
 * leaves out a wallet not looked up yet: then the whole reading is null, as a share of a part-read
 * list would read low. Hot funders (exchanges, services) link nobody.
 *
 * Two holders are linked when they share a funder, or one funded the other; clusters are the
 * groups that leaves, of two holders or more. The creator's ties are counted apart: a holder the
 * creator funded, who funded the creator, or with the creator's funder.
 */
export function linkedWallets(
  holders: readonly { owner: string; pct: number }[],
  funderOf: ReadonlyMap<string, string | null>,
  opts: { hot: (funder: string) => boolean; creator?: string | null; creatorFunder?: string | null },
): LinkedWalletsReading | null {
  const list = dedupeHolders(holders).filter((h) => h.owner !== opts.creator);
  if (list.length === 0) return null;
  if (list.some((h) => !funderOf.has(h.owner))) return null;
  const usable = (f: string | null | undefined): f is string => !!f && !opts.hot(f);

  // Union-find over holders, keyed by the funder each one points to.
  const parent = new Map<string, string>();
  const find = (a: string): string => {
    let r = a;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let x = a;
    while (parent.get(x) !== r) {
      const next = parent.get(x)!;
      parent.set(x, r);
      x = next;
    }
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  for (const h of list) parent.set(h.owner, h.owner);
  const byFunder = new Map<string, string>();
  const isHolder = new Set(list.map((h) => h.owner));
  for (const h of list) {
    const f = funderOf.get(h.owner);
    if (!usable(f)) continue;
    // One holder funded another.
    if (isHolder.has(f)) union(f, h.owner);
    const seen = byFunder.get(f);
    if (seen) union(seen, h.owner);
    else byFunder.set(f, h.owner);
  }

  const creator = opts.creator ?? null;
  const creatorFunder = usable(opts.creatorFunder) ? opts.creatorFunder : null;
  const tiedToCreator = (wallet: string) => {
    const f = funderOf.get(wallet) ?? null;
    return (
      !!creator &&
      ((f !== null && f === creator) ||
        (creatorFunder !== null && (f === creatorFunder || wallet === creatorFunder)))
    );
  };

  const groups = new Map<string, { owner: string; pct: number }[]>();
  for (const h of list) {
    const r = find(h.owner);
    const g = groups.get(r);
    if (g) g.push(h);
    else groups.set(r, [h]);
  }
  const clusters: LinkedCluster[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    members.sort((a, b) => b.pct - a.pct);
    clusters.push({
      funder: clusterFunder(members, funderOf, isHolder),
      wallets: members.map((m) => ({ wallet: m.owner, pct: round2(m.pct) })),
      pct: round2(members.reduce((s, m) => s + m.pct, 0)),
      creatorLinked: members.some((m) => tiedToCreator(m.owner)),
    });
  }
  clusters.sort((a, b) => b.pct - a.pct);
  return {
    linkedWalletPct: round2(clusters.reduce((s, c) => s + c.pct, 0)),
    linkedClusterCount: clusters.length,
    linkedLargestClusterPct: clusters[0]?.pct ?? 0,
    linkedCreatorPct: round2(list.filter((h) => tiedToCreator(h.owner)).reduce((s, h) => s + h.pct, 0)),
    linkedWalletsChecked: list.length,
    clusters,
    holders: [...list].sort((a, b) => b.pct - a.pct).map((h) => ({ wallet: h.owner, pct: round2(h.pct) })),
  };
}

/** The funder most of a cluster shares, or the holder that funded the others. */
function clusterFunder(
  members: readonly { owner: string }[],
  funderOf: ReadonlyMap<string, string | null>,
  isHolder: ReadonlySet<string>,
): string {
  const counts = new Map<string, number>();
  for (const m of members) {
    const f = funderOf.get(m.owner);
    if (f) counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [f, c] of counts)
    if (!best || c > counts.get(best)! || (c === counts.get(best) && isHolder.has(f))) best = f;
  return best ?? members[0]!.owner;
}

function dedupeHolders(holders: readonly { owner: string; pct: number }[]) {
  const out = new Map<string, number>();
  for (const h of holders) if (h.owner) out.set(h.owner, (out.get(h.owner) ?? 0) + h.pct);
  return [...out].map(([owner, pct]) => ({ owner, pct }));
}

const round2 = (v: number) => Math.round(v * 100) / 100;
