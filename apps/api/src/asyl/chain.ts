import {
  prisma,
  CreditTally,
  isWalletAddress,
  flowsFromTransactions,
  heliusCreditsOut,
  tallyHeliusCredits,
  withApiFeature,
  type Env,
  WALLET_DORMANT_GAP_MS,
  type HeliusClient,
  type KnownFunder,
  FUNDER_TXS_WALKED_MAX,
  type WalletFlows,
} from "@trenchscanner/core";
import type { Prisma } from "@prisma/client";
import { oneAtATime, readAllowance, recordSpend, type Allowance } from "./credits.js";
import { fundedEdge, GraphBuilder, hotFunders, sig2, type KnownDeployer } from "./graph.js";

/**
 * Asyl's chain reads, Pro Mode only (user decision 2026-10-24): what TrenchScanner's own tables
 * don't have. Every read checks the reader's allowance against its worst case first, runs under
 * the "asyl" feature in Admin > API usage, writes what it learns into the shared caches
 * (AsylFlowRead, WalletFunder) so the next look by anyone is free, and charges only the credits
 * the meter counted. While Helius says the plan's credits are out, nothing is asked.
 */

/** Flow reads: newest transactions, in pages of 100 (10 credits each). */
export const FLOW_PAGES = 3;
/** A flow read is kept and shared this long. */
export const ASYL_FLOW_TTL_MS = 24 * 3_600_000;
/** Funders read at once: up to 11 credits each for a busy wallet, 2 for most. */
export const FUNDERS_MAX = 20;
/** A coin's chain map: its top holders, and their funders the tables don't have. */
export const CHAIN_HOLDERS = 50;
export const CHAIN_HOLDER_FUNDERS = 30;
/** A coin's chain map is shared this long, in memory. */
export const TOKEN_READ_TTL_MS = 10 * 60_000;

/** Worst cases, held against the allowance before a read starts. */
export const FLOW_WORST = FLOW_PAGES * 10;
/** A funder read asked outright: its page, then up to FUNDER_TXS_WALKED_MAX oldest transactions. */
export const FUNDER_WORST = 1 + FUNDER_TXS_WALKED_MAX;
export const TOKEN_WORST = 10 + CHAIN_HOLDER_FUNDERS * 4;
/** A deployer read: one page of the mint's oldest transactions. */
export const DEPLOYER_WORST = 10;

export type ChainRefusal =
  | { refused: "not-pro" }
  | { refused: "allowance"; allowance: Allowance }
  | { refused: "credits-out" }
  | { refused: "busy" }
  | { refused: "unavailable" };

export interface ChainResult<T> {
  value: T;
  /** Credits this read took (0 when it came from a cache). */
  credits: number;
  allowance: Allowance;
  cached: boolean;
}

export type Chained<T> = ChainResult<T> | ChainRefusal;

export const short = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;
export const fmtAmount = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(1)}K`
      : n >= 10
        ? n.toFixed(0)
        : sig2(n);
export const fmtDay = (ms: number | null) =>
  ms === null
    ? null
    : new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/**
 * Runs one metered read for `userId`: checks, tallies, records. `cached` answers from a shared
 * cache first: free, so it is handed back even with the day's allowance short of a fresh read's
 * worst case, or while Helius's credits are out (the reader was told such a read costs nothing).
 */
export async function metered<T>(
  env: Env,
  userId: string,
  worst: number,
  /** Given the allowance as it stood before the read, for a read that goes on while it lasts. */
  read: (before: Allowance) => Promise<{ value: T; cached: boolean } | null>,
  cached?: () => Promise<T | null>,
): Promise<Chained<T>> {
  if (cached) {
    const hit = await cached().catch(() => null);
    if (hit !== null)
      return { value: hit, credits: 0, allowance: await readAllowance(env, userId), cached: true };
  }
  if (heliusCreditsOut()) return { refused: "credits-out" };
  const before = await readAllowance(env, userId);
  if (!before.enabled || before.left < worst) return { refused: "allowance", allowance: before };
  const out = await oneAtATime(userId, async () => {
    const tally = new CreditTally();
    const got = await withApiFeature("asyl", () => tallyHeliusCredits(tally, () => read(before)));
    const credits = tally.take();
    if (credits > 0) await recordSpend(userId, credits);
    return got ? { ...got, credits } : null;
  });
  if (out === "busy") return { refused: "busy" };
  if (!out) return { refused: "unavailable" };
  const allowance = out.credits > 0 ? await readAllowance(env, userId) : before;
  return { value: out.value, credits: out.credits, allowance, cached: out.cached };
}

/**
 * A wallet's flows kept within the day, else null. A read kept from before bridges were read
 * (no `bridges`) is read again, so Bridges never answers "none" for a wallet it never looked at.
 */
async function keptFlows(wallet: string, now: number): Promise<WalletFlows | null> {
  const row = await prisma.asylFlowRead.findUnique({ where: { wallet } });
  const flows =
    row && now - row.readAt.getTime() < ASYL_FLOW_TTL_MS ? (row.flows as unknown as WalletFlows) : null;
  return flows?.bridges ? flows : null;
}

/** A wallet's flows: kept for a day, else read from its newest FLOW_PAGES pages and kept. */
export async function loadFlows(
  helius: Pick<HeliusClient, "getWalletTransactionsPage">,
  wallet: string,
  now: number,
): Promise<{ value: WalletFlows; cached: boolean } | null> {
  const hit = await keptFlows(wallet, now);
  if (hit) return { value: hit, cached: true };
  const txs = [];
  let token: string | undefined;
  for (let page = 0; page < FLOW_PAGES; page++) {
    const res = await helius.getWalletTransactionsPage(wallet, token ? { paginationToken: token } : {});
    if (res.status !== "ok") {
      if (page === 0) return null;
      break;
    }
    txs.push(...res.txs);
    if (!res.paginationToken) break;
    token = res.paginationToken;
  }
  const flows = flowsFromTransactions(wallet, txs);
  const row = {
    readAt: new Date(now),
    flows: flows as unknown as Prisma.InputJsonValue,
    txs: flows.txs,
  };
  await prisma.asylFlowRead
    .upsert({ where: { wallet }, create: { wallet, ...row }, update: row })
    .catch(() => undefined);
  return { value: flows, cached: false };
}

/** A wallet's recent flows: kept for a day, else read from its newest FLOW_PAGES pages. */
export function readWalletFlows(
  env: Env,
  helius: Pick<HeliusClient, "getWalletTransactionsPage">,
  userId: string,
  wallet: string,
  now = Date.now(),
): Promise<Chained<WalletFlows>> {
  return metered(
    env,
    userId,
    FLOW_WORST,
    () => loadFlows(helius, wallet, now),
    () => keptFlows(wallet, now),
  );
}

/**
 * Hops an exit trace follows at most (user ask 2026-10-26, "where did the money go"): each hop is
 * a flow read of up to FLOW_WORST credits, so a trace costs at most EXIT_HOPS * FLOW_WORST.
 */
export const EXIT_HOPS = 6;
/** SOL a hop must send on to count: dust and rent refunds aren't where the money went. */
export const EXIT_MIN_SOL = 0.1;

/**
 * Why an exit trace stopped. "exchange": the money reached an exchange or service wallet.
 * "cold": the last wallet sent no SOL on that the read saw (it still holds it, or spent it on
 * coins). The rest as for a funder trace.
 */
export type ExitStop = "exchange" | "cold" | "loop" | "limit" | "allowance" | "paused" | "unreadable";

export interface ExitHop {
  from: string;
  to: string;
  sol: number;
  count: number;
  lastAt: number | null;
}

export interface ExitTrace {
  /** The wallet, then where it sent most SOL, then where that one sent most, as far as it went. */
  path: string[];
  hops: ExitHop[];
  stop: ExitStop;
  /** Flow reads that went to the chain (the rest were kept reads). */
  asked: number;
}

/** The SOL a flow read saw leave for each wallet, most first, as hops. */
export function biggestOut(flows: WalletFlows, skip: ReadonlySet<string>): ExitHop | null {
  const outs = flows.transfers
    .filter(
      (t) =>
        t.dir === "out" &&
        t.mint === null &&
        t.amount >= EXIT_MIN_SOL &&
        !skip.has(t.counterparty) &&
        isWalletAddress(t.counterparty),
    )
    .sort((a, b) => b.amount - a.amount);
  const t = outs[0];
  return t
    ? { from: flows.wallet, to: t.counterparty, sol: t.amount, count: t.count, lastAt: t.lastAt }
    : null;
}

/**
 * Follows the money out of a wallet (user ask 2026-10-26): at each hop, the wallet it sent the most
 * SOL to, until an exchange or service, a wallet that sent nothing on, a loop, or EXIT_HOPS hops.
 * Each hop's flow read is kept for a day for everyone, as Read its transfers does.
 */
export function traceExits(
  env: Env,
  helius: Pick<HeliusClient, "getWalletTransactionsPage">,
  userId: string,
  wallet: string,
  now = Date.now(),
): Promise<Chained<ExitTrace>> {
  return metered(env, userId, FLOW_WORST, async (before) => {
    const path = [wallet];
    const hops: ExitHop[] = [];
    let asked = 0;
    const done = (stop: ExitStop) => ({ value: { path, hops, stop, asked }, cached: asked === 0 });
    for (let at = wallet; ;) {
      if (at !== wallet && (await hotFunders([at])).has(at)) return done("exchange");
      if (hops.length >= EXIT_HOPS) return done("limit");
      if (heliusCreditsOut()) return done("paused");
      if (before.left < (asked + 1) * FLOW_WORST) return done("allowance");
      const r = await loadFlows(helius, at, now).catch(() => null);
      if (!r) return done("unreadable");
      if (!r.cached) asked += 1;
      const hop = biggestOut(r.value, new Set([at]));
      if (!hop) return done("cold");
      hops.push(hop);
      if (path.includes(hop.to)) return done("loop");
      path.push(hop.to);
      at = hop.to;
    }
  });
}

/** An exit trace drawn on the map: each hop a SOL transfer, the last tagged when it's an exchange. */
export function addExitTrace(g: GraphBuilder, trace: ExitTrace): void {
  const last = trace.path[trace.path.length - 1]!;
  for (const w of trace.path)
    g.node(w, "wallet", w === last && trace.stop === "exchange" ? { tags: ["exchange"] } : {});
  for (const h of trace.hops)
    g.edge({
      a: h.from,
      b: h.to,
      kind: "transfer",
      weight: h.sol,
      label: [`Sent ${fmtAmount(h.sol)} SOL`, h.count > 1 ? `${h.count}×` : null, fmtDay(h.lastAt)]
        .filter(Boolean)
        .join(" · "),
      source: "chain",
      mint: null,
      at: h.lastAt === null ? null : new Date(h.lastAt).toISOString(),
      sol: h.sol,
    });
}

/** What an exit trace found, in a line. */
export function exitNote(trace: ExitTrace, name: string | null = null): string {
  const n = trace.hops.length;
  const last = trace.path[trace.path.length - 1]!;
  const who = name ?? short(last);
  const total = trace.hops[0]?.sol;
  const went = n === 0 ? "" : `Followed the money ${n} hop${n === 1 ? "" : "s"}. `;
  switch (trace.stop) {
    case "exchange":
      return `${went}It ends at ${who}, an exchange or service wallet${total ? `, ${fmtAmount(total)} SOL sent from the start` : ""}.`;
    case "cold":
      return n === 0
        ? "It sent no SOL on in its recent transactions: the money is still there, or went into coins."
        : `${went}${who} sent nothing on in its recent transactions: the money is still there, or went into coins.`;
    case "loop":
      return `${went}The money came back round to ${who}.`;
    case "limit":
      return `${went}Stopped after ${EXIT_HOPS} hops at ${who}. Trace again from there to go further.`;
    case "allowance":
      return `${went}Today's chain-read allowance ran short at ${who}. It resets at midnight UTC.`;
    case "paused":
      return `${went}Chain reads paused at ${who}. Try again in a few minutes.`;
    case "unreadable":
      return `${went}The chain couldn't read ${who}'s transfers, so the trace stops there. Try again later.`;
  }
}

/**
 * Reads the funders of `wallets` whose stored answer doesn't hold, and writes them into WalletFunder
 * for everyone, the way the worker's linked-wallets read does: an answer holds until the wallet's
 * newest transaction at the read plus WALLET_DORMANT_GAP_MS, when it could sit idle and be paid
 * again by someone new; a busy or failed read, or a row from before that was kept, holds not at all.
 * A stored answer is handed back, so a wallet that hasn't revived costs only its one page. Returns
 * how many were asked, how many named a funder, and each wallet's answer as it now stands.
 *
 * `outright`: the reader asked for these funders by name (Find its funder, a trace). A stored
 * "none" is read again, walking up to FUNDER_TXS_WALKED_MAX of its oldest transactions: the scan's
 * bulk read walks only FUNDER_TXS_WALKED, and a wallet whose first few transactions were token
 * accounts opened for it or airdrops comes back "none" there though someone did pay it in (user
 * bug report 2026-10-25).
 */
export async function refreshFunders(
  helius: Pick<HeliusClient, "getFundersBatch">,
  wallets: readonly string[],
  now = Date.now(),
  /** Reads at most this many, first in `wallets` order. */
  max = Infinity,
  outright = false,
): Promise<{ asked: number; found: number; status: Map<string, FunderStatus> }> {
  const rows = await prisma.walletFunder.findMany({
    where: { wallet: { in: [...wallets] } },
    select: {
      wallet: true,
      status: true,
      funder: true,
      amountSol: true,
      fundedAt: true,
      lastActivityAt: true,
    },
  });
  const settled = (r: (typeof rows)[number]) =>
    (r.status === "found" || (r.status === "none" && !outright) || r.status === "empty") &&
    (r.status === "empty" ||
      (!!r.lastActivityAt && now < r.lastActivityAt.getTime() + WALLET_DORMANT_GAP_MS));
  const byWallet = new Map(rows.map((r) => [r.wallet, r]));
  const ask = wallets
    .filter((w) => {
      const r = byWallet.get(w);
      return !r || !settled(r);
    })
    .slice(0, max);
  const status = new Map<string, FunderStatus>();
  for (const w of wallets) {
    const r = byWallet.get(w);
    if (r) status.set(w, r.status as FunderStatus);
  }
  if (ask.length === 0) return { asked: 0, found: 0, status };
  const knownOf = new Map<string, KnownFunder>();
  for (const w of ask) {
    const r = byWallet.get(w);
    // A stored "none" asked outright is walked again, deeper, rather than handed back.
    if (r && (r.status === "found" || (r.status === "none" && !outright)))
      knownOf.set(w, { funder: r.funder, amountSol: r.amountSol, fundedAt: r.fundedAt });
  }
  const read = await helius.getFundersBatch(ask, {
    nowMs: now,
    knownOf,
    ...(outright ? { walk: FUNDER_TXS_WALKED_MAX } : {}),
  });
  let found = 0;
  for (const [wallet, r] of read) {
    // A failed read changes nothing; a busy one only stands in for a missing or busy row. Either
    // way the reader hears what this read found, not an older answer it couldn't confirm.
    if (r.status === "failed") {
      if (!status.has(wallet) || outright) status.set(wallet, "failed");
      continue;
    }
    if (r.status === "busy" && byWallet.has(wallet) && byWallet.get(wallet)!.status !== "busy") {
      if (outright) status.set(wallet, "busy");
      continue;
    }
    status.set(wallet, r.status);
    const row = {
      wallet,
      status: r.status,
      funder: r.status === "found" ? r.funder : null,
      amountSol: r.status === "found" ? r.amountSol : null,
      fundedAt: r.status === "found" ? r.fundedAt : null,
      lastActivityAt: "lastActivityAt" in r ? (r.lastActivityAt ?? null) : null,
      revived: "revived" in r ? (r.revived ?? null) : null,
      checkedAt: new Date(now),
    };
    if (r.status === "found") found += 1;
    await prisma.walletFunder.upsert({ where: { wallet }, create: row, update: row }).catch(() => undefined);
  }
  return { asked: ask.length, found, status };
}

/** A funder answer as the reader hears it. */
export type FunderStatus = "found" | "none" | "empty" | "busy" | "failed";

/** Funders the tables don't have, or whose stored answer no longer holds, read for everyone. */
export function readFunders(
  env: Env,
  helius: Pick<HeliusClient, "getFundersBatch">,
  userId: string,
  wallets: readonly string[],
): Promise<Chained<Record<string, FunderStatus>>> {
  const unique = [...new Set(wallets)].slice(0, FUNDERS_MAX);
  return metered(env, userId, FUNDER_WORST * Math.max(1, Math.min(unique.length, 5)), async () => {
    const { asked, status } = await refreshFunders(helius, unique, Date.now(), Infinity, true);
    return {
      value: Object.fromEntries(unique.map((w) => [w, status.get(w) ?? "failed"])),
      cached: asked === 0,
    };
  });
}

/**
 * Hops a funder trace follows at most (user ask 2026-10-25): past this it is a chain of throwaway
 * wallets, and the next hop is rarely worth its credits. Bounds a trace at TRACE_HOPS * FUNDER_WORST.
 */
export const TRACE_HOPS = 10;

/**
 * Why a trace stopped. "exchange": an exchange or other service wallet, where the money's trail
 * goes into the crowd. "origin": nothing paid the last wallet SOL before its first moves (it was
 * funded some other way, or by a mint). "busy": too many transactions to find its first, which is a
 * service's mark too. "unreadable": the read failed, or the funder is a program account. "loop":
 * the trail came back on itself. "limit": TRACE_HOPS hops. "allowance": the day's credits ran short
 * of the next hop. "paused": Helius's credits are out for now.
 */
export type TraceStop =
  "exchange" | "origin" | "busy" | "unreadable" | "loop" | "limit" | "allowance" | "paused";

export interface FunderTrace {
  /** The wallet, then its funder, then that funder's funder, as far as the trace went. */
  path: string[];
  stop: TraceStop;
  /** Funder reads that went to the chain (the rest were stored answers that still hold). */
  asked: number;
}

/**
 * Follows a wallet's funder, and the funder's funder, until an exchange or service, a wallet the
 * chain can't name a funder for, a read that fails, or TRACE_HOPS hops. Stored answers that still
 * hold are free; each new read is written to WalletFunder for everyone, as Find its funder does.
 */
export function traceFunders(
  env: Env,
  helius: Pick<HeliusClient, "getFundersBatch">,
  userId: string,
  wallet: string,
  now = Date.now(),
): Promise<Chained<FunderTrace>> {
  return metered(env, userId, FUNDER_WORST, async (before) => {
    const path = [wallet];
    let asked = 0;
    const done = (stop: TraceStop) => ({ value: { path, stop, asked }, cached: asked === 0 });
    for (let at = wallet; ;) {
      if ((await hotFunders([at])).has(at)) return done("exchange");
      if (path.length > TRACE_HOPS) return done("limit");
      if (heliusCreditsOut()) return done("paused");
      // Each new read can take up to FUNDER_WORST: stop while what's left still covers it.
      if (before.left < (asked + 1) * FUNDER_WORST) return done("allowance");
      const r = await refreshFunders(helius, [at], now, Infinity, true).catch(() => null);
      if (!r) return done("unreadable");
      asked += r.asked;
      const row = await prisma.walletFunder.findUnique({
        where: { wallet: at },
        select: { status: true, funder: true },
      });
      if (!row || row.status === "failed") return done("unreadable");
      if (row.status === "busy") return done("busy");
      if (row.status !== "found" || !row.funder) return done("origin");
      if (path.includes(row.funder)) return done("loop");
      path.push(row.funder);
      if (!isWalletAddress(row.funder)) return done("unreadable");
      at = row.funder;
    }
  });
}

/** A trace drawn on the map: each wallet funded by the next, the last tagged when it's an exchange. */
export async function addTrace(g: GraphBuilder, trace: FunderTrace): Promise<void> {
  const rows = await prisma.walletFunder.findMany({
    where: { wallet: { in: trace.path } },
    select: { wallet: true, funder: true, amountSol: true, fundedAt: true },
  });
  const byWallet = new Map(rows.map((r) => [r.wallet, r]));
  const last = trace.path[trace.path.length - 1]!;
  for (const w of trace.path)
    g.node(w, "wallet", w === last && trace.stop === "exchange" ? { tags: ["exchange"] } : {});
  for (let i = 0; i + 1 < trace.path.length; i++) {
    const r = byWallet.get(trace.path[i]!);
    fundedEdge(g, trace.path[i + 1]!, trace.path[i]!, {
      amountSol: r?.amountSol ?? null,
      fundedAt: r?.fundedAt ?? null,
    });
  }
}

/** What a trace found, in a line: how far it went and why it stopped there. */
export function traceNote(trace: FunderTrace, name: string | null = null): string {
  const hops = trace.path.length - 1;
  const last = trace.path[trace.path.length - 1]!;
  const who = name ?? short(last);
  const went = hops === 0 ? "" : `Traced ${hops} funder${hops === 1 ? "" : "s"} back. `;
  switch (trace.stop) {
    case "exchange":
      return hops === 0
        ? `${who} is an exchange or service wallet: its money comes from the crowd, so there's no one funder to trace.`
        : `${went}The trail ends at ${who}, an exchange or service wallet that pays thousands of strangers.`;
    case "origin":
      return hops === 0
        ? "No funder found: nothing paid it SOL before its first transactions."
        : `${went}${who} is where it starts: nothing paid it SOL before its first transactions.`;
    case "busy":
      return `${went}${who} has too many transactions to find its first: most likely an exchange or service.`;
    case "unreadable":
      return `${went}The chain couldn't name ${who}'s funder, so the trace stops there. Try again later.`;
    case "loop":
      return `${went}The trail loops back on itself at ${who}.`;
    case "limit":
      return `${went}Stopped after ${TRACE_HOPS} hops at ${who}. Trace again from there to go further.`;
    case "allowance":
      return `${went}Today's chain-read allowance ran short at ${who}. It resets at midnight UTC.`;
    case "paused":
      return `${went}Chain reads paused at ${who}. Try again in a few minutes.`;
  }
}

const tokenReads = new Map<string, { at: number; holders: { wallet: string; pct: number }[] }>();

/** A coin's top holders from the chain, for a coin TrenchScanner has no map of. */
export function readTokenHolders(
  env: Env,
  helius: Pick<HeliusClient, "getTopHoldersBatch" | "getFundersBatch">,
  userId: string,
  mint: string,
  now = Date.now(),
): Promise<Chained<{ wallet: string; pct: number }[]>> {
  const recent = async () => {
    const hit = tokenReads.get(mint);
    return hit && now - hit.at < TOKEN_READ_TTL_MS ? hit.holders : null;
  };
  return metered(
    env,
    userId,
    TOKEN_WORST,
    async () => {
      const hit = await recent();
      if (hit) return { value: hit, cached: true };
      const res = (await helius.getTopHoldersBatch([mint], CHAIN_HOLDERS)).get(mint);
      if (!res || res.status !== "found") return null;
      const holders = res.holders.map((h) => ({ wallet: h.owner, pct: h.pct }));
      // Their funders, so the map can tie them: only the ones the tables don't have, or have stale,
      // and only wallets: a pool or a bonding curve among the top holders has no funder to spend on.
      await refreshFunders(
        helius,
        holders.map((h) => h.wallet).filter((w) => isWalletAddress(w)),
        now,
        CHAIN_HOLDER_FUNDERS,
      ).catch(() => undefined);
      if (tokenReads.size > 500) tokenReads.clear();
      tokenReads.set(mint, { at: now, holders });
      return { value: holders, cached: false };
    },
    recent,
  );
}

/** A flow read drawn on the map: transfers as edges to counterparties, trades as coin edges. */
export function addFlows(g: GraphBuilder, flows: WalletFlows): void {
  const me = flows.wallet;
  g.node(me, "wallet");
  for (const t of flows.transfers) {
    g.node(t.counterparty, "wallet");
    if (t.mint) g.node(t.mint, "token");
    const [a, b] = t.dir === "out" ? [me, t.counterparty] : [t.counterparty, me];
    const what = t.mint ? `${fmtAmount(t.amount)} coins` : `${fmtAmount(t.amount)} SOL`;
    g.edge({
      a,
      b,
      kind: "transfer",
      // SOL by size; a coin transfer counts by how often, as coin amounts don't compare across coins.
      weight: t.mint ? t.count : t.amount,
      label: [`Sent ${what}`, t.count > 1 ? `${t.count}×` : null, fmtDay(t.lastAt)]
        .filter(Boolean)
        .join(" · "),
      source: "chain",
      mint: t.mint,
      at: t.lastAt === null ? null : new Date(t.lastAt).toISOString(),
      ...(t.mint ? { tokens: t.amount } : { sol: t.amount }),
    });
  }
  for (const t of flows.trades) {
    g.node(t.mint, "token");
    const net = t.solOut - t.solIn;
    g.edge({
      a: me,
      b: t.mint,
      kind: "traded",
      weight: Math.max(t.solIn, t.solOut, 0.01),
      label: [
        `${t.buys} buy${t.buys === 1 ? "" : "s"}, ${t.sells} sell${t.sells === 1 ? "" : "s"}`,
        t.sells > 0 ? `${net >= 0 ? "+" : ""}${net.toFixed(2)} SOL` : `in ${t.solIn.toFixed(2)} SOL`,
      ].join(" · "),
      source: "chain",
      mint: t.mint,
      at: t.lastAt === null ? null : new Date(t.lastAt).toISOString(),
      sol: Math.max(t.solIn, t.solOut),
      net: t.sells > 0 ? net : null,
    });
  }
}

/**
 * A coin's deployer from the chain: the signer of its create transaction (core's
 * deployerFromTransactions), kept in Token.deployer so every later look, by anyone, is free.
 * Null value: the chain answered, and named no wallet.
 */
export function readDeployer(
  env: Env,
  helius: Pick<HeliusClient, "getMintDeployersBatch">,
  userId: string,
  mint: string,
): Promise<Chained<KnownDeployer | null>> {
  return metered(env, userId, DEPLOYER_WORST, async () => {
    const r = (await helius.getMintDeployersBatch([mint])).get(mint);
    if (!r || r.status === "failed" || r.status === "unsupported") return null;
    if (r.status === "none") return { value: null, cached: false };
    await prisma.token
      .updateMany({ where: { mintAddress: mint }, data: { deployer: r.deployer } })
      .catch(() => undefined);
    return { value: { wallet: r.deployer, verified: true, at: r.at }, cached: false };
  });
}
