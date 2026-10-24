import {
  prisma,
  CreditTally,
  flowsFromTransactions,
  heliusCreditsOut,
  tallyHeliusCredits,
  withApiFeature,
  type Env,
  type HeliusClient,
  type WalletFlows,
} from "@trenchscanner/core";
import type { Prisma } from "@prisma/client";
import { oneAtATime, readAllowance, recordSpend, type Allowance } from "./credits.js";
import { GraphBuilder } from "./graph.js";

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
export const FUNDER_WORST = 11;
export const TOKEN_WORST = 10 + CHAIN_HOLDER_FUNDERS * 4;

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

type Chained<T> = ChainResult<T> | ChainRefusal;

/** Runs one metered read for `userId`: checks, tallies, records. */
async function metered<T>(
  env: Env,
  userId: string,
  worst: number,
  read: () => Promise<{ value: T; cached: boolean } | null>,
): Promise<Chained<T>> {
  if (heliusCreditsOut()) return { refused: "credits-out" };
  const before = await readAllowance(env, userId);
  if (!before.enabled || before.left < worst) return { refused: "allowance", allowance: before };
  const out = await oneAtATime(userId, async () => {
    const tally = new CreditTally();
    const got = await withApiFeature("asyl", () => tallyHeliusCredits(tally, read));
    const credits = tally.take();
    if (credits > 0) await recordSpend(userId, credits);
    return got ? { ...got, credits } : null;
  });
  if (out === "busy") return { refused: "busy" };
  if (!out) return { refused: "unavailable" };
  const allowance = out.credits > 0 ? await readAllowance(env, userId) : before;
  return { value: out.value, credits: out.credits, allowance, cached: out.cached };
}

/** A wallet's recent flows: kept for a day, else read from its newest FLOW_PAGES pages. */
export function readWalletFlows(
  env: Env,
  helius: Pick<HeliusClient, "getWalletTransactionsPage">,
  userId: string,
  wallet: string,
  now = Date.now(),
): Promise<Chained<WalletFlows>> {
  return metered(env, userId, FLOW_WORST, async () => {
    const kept = await prisma.asylFlowRead.findUnique({ where: { wallet } });
    if (kept && now - kept.readAt.getTime() < ASYL_FLOW_TTL_MS)
      return { value: kept.flows as unknown as WalletFlows, cached: true };
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
  });
}

/** Funders the tables don't have yet, read and written into WalletFunder for everyone. */
export function readFunders(
  env: Env,
  helius: Pick<HeliusClient, "getFundersBatch">,
  userId: string,
  wallets: readonly string[],
): Promise<Chained<number>> {
  const unique = [...new Set(wallets)].slice(0, FUNDERS_MAX);
  return metered(env, userId, FUNDER_WORST * Math.max(1, Math.min(unique.length, 5)), async () => {
    const have = await prisma.walletFunder.findMany({
      where: { wallet: { in: unique } },
      select: { wallet: true },
    });
    const known = new Set(have.map((h) => h.wallet));
    const ask = unique.filter((w) => !known.has(w));
    if (ask.length === 0) return { value: 0, cached: true };
    const read = await helius.getFundersBatch(ask);
    let found = 0;
    for (const [wallet, r] of read) {
      if (r.status !== "found" && r.status !== "none" && r.status !== "empty") continue;
      const row = {
        wallet,
        status: r.status,
        funder: r.status === "found" ? r.funder : null,
        amountSol: r.status === "found" ? r.amountSol : null,
        fundedAt: r.status === "found" ? r.fundedAt : null,
      };
      if (r.status === "found") found += 1;
      await prisma.walletFunder
        .upsert({ where: { wallet }, create: row, update: { ...row, checkedAt: new Date() } })
        .catch(() => undefined);
    }
    return { value: found, cached: false };
  });
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
  return metered(env, userId, TOKEN_WORST, async () => {
    const hit = tokenReads.get(mint);
    if (hit && now - hit.at < TOKEN_READ_TTL_MS) return { value: hit.holders, cached: true };
    const res = (await helius.getTopHoldersBatch([mint], CHAIN_HOLDERS)).get(mint);
    if (!res || res.status !== "found") return null;
    const holders = res.holders.map((h) => ({ wallet: h.owner, pct: h.pct }));
    // Their funders, so the map can tie them: only the ones the tables don't have.
    const have = await prisma.walletFunder.findMany({
      where: { wallet: { in: holders.map((h) => h.wallet) } },
      select: { wallet: true },
    });
    const known = new Set(have.map((h) => h.wallet));
    const ask = holders
      .map((h) => h.wallet)
      .filter((w) => !known.has(w))
      .slice(0, CHAIN_HOLDER_FUNDERS);
    if (ask.length > 0) {
      const read = await helius.getFundersBatch(ask);
      for (const [wallet, r] of read) {
        if (r.status !== "found" && r.status !== "none" && r.status !== "empty") continue;
        const row = {
          wallet,
          status: r.status,
          funder: r.status === "found" ? r.funder : null,
          amountSol: r.status === "found" ? r.amountSol : null,
          fundedAt: r.status === "found" ? r.fundedAt : null,
        };
        await prisma.walletFunder
          .upsert({ where: { wallet }, create: row, update: { ...row, checkedAt: new Date() } })
          .catch(() => undefined);
      }
    }
    if (tokenReads.size > 500) tokenReads.clear();
    tokenReads.set(mint, { at: now, holders });
    return { value: holders, cached: false };
  });
}

const fmtAmount = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(1)}K`
      : n >= 10
        ? n.toFixed(0)
        : n.toPrecision(2);
const fmtDay = (ms: number | null) =>
  ms === null
    ? null
    : new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

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
    });
  }
}
