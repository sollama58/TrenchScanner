import {
  adminWalletSet,
  BRIDGE_PROGRAMS,
  creditBalance,
  dailyFreeCredits,
  heliusCreditsOut,
  isWalletAddress,
  openLookup,
  resolveAccess,
  spendCredits,
  type Env,
  type HeliusClient,
  type SpendOutcome,
  type SpendUtility,
  type WalletFlowBridge,
  type WalletFlows,
} from "@trenchscanner/core";
import { FLOW_WORST, fmtAmount, fmtDay, loadFlows, metered, short, type Chained } from "./chain.js";
import { hotFunders, type GraphBuilder } from "./graph.js";

/**
 * Asyl's chain tools priced in Burn Credits (user ask 2026-10-26, "for pricing can we have some
 * things take Burn Credits?"): any signed-in wallet can run them, Pro Mode or not, and pays the
 * same credits the Utilities lookups take (core subscription/credits.ts). A subscriber's free daily
 * credits go first. The charge is taken after the read succeeds, never before, and asking again
 * for the same wallet within the hour (LOOKUP_REOPEN_MS) is free.
 *
 * The Helius credits these reads take are still metered and still count toward the site's daily
 * chain cap, under the reader's "burn:" row in AsylCreditUse, so they never eat a Pro user's own
 * allowance and a script with credits to burn still can't run Helius dry.
 */

export type PaidTool = Extract<SpendUtility, `asyl-${string}`>;

/** Burn Credits per read. */
export const PAID_COST: Record<PaidTool, number> = { "asyl-deposits": 3, "asyl-bridges": 1 };

/** The AsylCreditUse row a paid read's Helius credits are recorded under. */
export const burnId = (userId: string) => `burn:${userId}`;

export type BurnCheck =
  { ok: true; dailyFree: boolean } | { ok: false; balance: number; cost: number; freeLeft: number };

/** Whether `wallet` can pay for `tool` on `subject`: already paid within the hour, or enough credits. */
export async function burnCheck(
  env: Env,
  wallet: string,
  tool: PaidTool,
  subject: string,
): Promise<BurnCheck> {
  const cost = PAID_COST[tool];
  const [open, access] = await Promise.all([
    openLookup(wallet, tool, subject),
    resolveAccess(wallet, adminWalletSet(env)).catch(() => null),
  ]);
  const dailyFree = access?.reason === "subscription";
  if (open) return { ok: true, dailyFree };
  const [balance, daily] = await Promise.all([
    creditBalance(wallet),
    dailyFree ? dailyFreeCredits(wallet) : null,
  ]);
  const freeLeft = daily?.left ?? 0;
  return balance + freeLeft >= cost ? { ok: true, dailyFree } : { ok: false, balance, cost, freeLeft };
}

/** Takes the read's credits once it has succeeded. */
export function chargeFor(
  wallet: string,
  tool: PaidTool,
  subject: string,
  dailyFree: boolean,
): Promise<SpendOutcome> {
  return spendCredits(wallet, tool, subject, PAID_COST[tool], dailyFree);
}

/** A wallet's Burn Credits as Asyl shows them: the balance, and a subscriber's free ones left today. */
export async function burnStanding(env: Env, wallet: string) {
  const access = await resolveAccess(wallet, adminWalletSet(env)).catch(() => null);
  const [balance, daily] = await Promise.all([
    creditBalance(wallet),
    access?.reason === "subscription" ? dailyFreeCredits(wallet) : null,
  ]);
  return {
    balance,
    freeLeft: daily?.left ?? null,
    cost: { deposits: PAID_COST["asyl-deposits"], bridges: PAID_COST["asyl-bridges"] },
  };
}

// ---------- shared exchange deposits ----------

/** Wallets a deposit read checks: the ones the wallet sent to most often. */
export const DEPOSIT_CANDIDATES = 4;
/** Its own flow read, then one for each candidate. */
export const DEPOSIT_WORST = FLOW_WORST * (1 + DEPOSIT_CANDIDATES);
/** Share of a wallet's sends that must go to exchanges for it to read as a deposit address. */
export const DEPOSIT_SWEEP_SHARE = 0.8;
/** Other depositors kept per deposit address. */
export const DEPOSITORS_MAX = 15;

export interface Moved {
  sol: number;
  count: number;
  lastAt: number | null;
}

export interface DepositAddress {
  address: string;
  /** The exchange wallet it sweeps to. */
  exchange: string;
  /** What the wallet read sent it. */
  sent: Moved;
  /** What it swept on to exchanges. */
  swept: Moved;
  /** Other wallets that paid into it: likely the same exchange account's owner. */
  depositors: ({ wallet: string } & Moved)[];
}

export type DepositStop = "done" | "allowance" | "paused";

export interface DepositCluster {
  wallet: string;
  /** Candidates whose flows were read. */
  checked: number;
  deposits: DepositAddress[];
  stop: DepositStop;
  /** Flow reads that went to the chain. */
  asked: number;
}

const addMove = (m: Moved, sol: number, count: number, lastAt: number | null): Moved => ({
  sol: m.sol + sol,
  count: m.count + count,
  lastAt: lastAt === null ? m.lastAt : m.lastAt === null ? lastAt : Math.max(m.lastAt, lastAt),
});
const none = (): Moved => ({ sol: 0, count: 0, lastAt: null });

/** Each counterparty's moves one way, summed over coins (SOL counted as SOL, coins by count only). */
function byCounterparty(flows: WalletFlows, dir: "in" | "out"): Map<string, Moved> {
  const out = new Map<string, Moved>();
  for (const t of flows.transfers) {
    if (t.dir !== dir) continue;
    out.set(
      t.counterparty,
      addMove(out.get(t.counterparty) ?? none(), t.mint ? 0 : t.amount, t.count, t.lastAt),
    );
  }
  return out;
}

/** Where a wallet sent most often (then most SOL), leaving out exchanges: the deposit addresses to check. */
export function depositCandidates(flows: WalletFlows, hot: ReadonlySet<string>): string[] {
  return [...byCounterparty(flows, "out")]
    .filter(([w]) => w !== flows.wallet && !hot.has(w) && isWalletAddress(w))
    .sort((a, b) => b[1].count - a[1].count || b[1].sol - a[1].sol)
    .slice(0, DEPOSIT_CANDIDATES)
    .map(([w]) => w);
}

/**
 * Reads `flows` as an exchange deposit address: nearly everything it sends goes to exchange
 * wallets (it is swept), and the wallets that paid into it are its depositors.
 */
export function asDeposit(
  flows: WalletFlows,
  hot: ReadonlySet<string>,
): Omit<DepositAddress, "address" | "sent"> | null {
  const outs = byCounterparty(flows, "out");
  let all = 0;
  let toHot = 0;
  let exchange: string | null = null;
  let best = 0;
  let swept = none();
  for (const [w, m] of outs) {
    all += m.count;
    if (!hot.has(w)) continue;
    toHot += m.count;
    swept = addMove(swept, m.sol, m.count, m.lastAt);
    if (m.count > best) [exchange, best] = [w, m.count];
  }
  if (!exchange || toHot / all < DEPOSIT_SWEEP_SHARE) return null;
  const depositors = [...byCounterparty(flows, "in")]
    .filter(([w]) => !hot.has(w) && isWalletAddress(w))
    .sort((a, b) => b[1].count - a[1].count || b[1].sol - a[1].sol)
    .slice(0, DEPOSITORS_MAX)
    .map(([wallet, m]) => ({ wallet, ...m }));
  return { exchange, swept, depositors };
}

/**
 * Wallets that pay into the same exchange deposit address as `wallet` (user ask 2026-10-26): an
 * exchange gives each account its own deposit address and sweeps it, so two wallets paying the same
 * one most likely belong to the same person. Reads the wallet's flows, then up to
 * DEPOSIT_CANDIDATES of the wallets it sent to most; each read kept for a day for everyone.
 */
export function findSharedDeposits(
  env: Env,
  helius: Pick<HeliusClient, "getWalletTransactionsPage">,
  userId: string,
  wallet: string,
  now = Date.now(),
): Promise<Chained<DepositCluster>> {
  return metered(env, burnId(userId), DEPOSIT_WORST, async (before) => {
    const own = await loadFlows(helius, wallet, now).catch(() => null);
    if (!own) return null;
    let asked = own.cached ? 0 : 1;
    const sentTo = byCounterparty(own.value, "out");
    const candidates = depositCandidates(own.value, await hotFunders([...sentTo.keys()]));
    const deposits: DepositAddress[] = [];
    let checked = 0;
    let stop: DepositStop = "done";
    for (const c of candidates) {
      if (heliusCreditsOut()) {
        stop = "paused";
        break;
      }
      if (before.left < (asked + 1) * FLOW_WORST) {
        stop = "allowance";
        break;
      }
      const r = await loadFlows(helius, c, now).catch(() => null);
      if (!r) continue;
      if (!r.cached) asked += 1;
      checked += 1;
      const hot = await hotFunders(r.value.transfers.map((t) => t.counterparty));
      const d = asDeposit(r.value, hot);
      if (!d) continue;
      deposits.push({
        address: c,
        sent: sentTo.get(c) ?? none(),
        ...d,
        depositors: d.depositors.filter((x) => x.wallet !== wallet),
      });
    }
    return { value: { wallet, checked, deposits, stop, asked }, cached: asked === 0 };
  });
}

const sentLabel = (verb: string, m: Moved) =>
  [m.sol > 0 ? `${verb} ${fmtAmount(m.sol)} SOL` : verb, m.count > 1 ? `${m.count}×` : null, fmtDay(m.lastAt)]
    .filter(Boolean)
    .join(" · ");

const moneyEdge = (g: GraphBuilder, a: string, b: string, label: string, m: Moved) =>
  g.edge({
    a,
    b,
    kind: "transfer",
    weight: m.sol > 0 ? m.sol : m.count,
    label,
    source: "chain",
    mint: null,
    at: m.lastAt === null ? null : new Date(m.lastAt).toISOString(),
    sol: m.sol > 0 ? m.sol : null,
  });

/** Deposit addresses drawn: the wallet into each, each swept to its exchange, the other depositors into it. */
export function addDeposits(g: GraphBuilder, cluster: DepositCluster): void {
  g.node(cluster.wallet, "wallet");
  for (const d of cluster.deposits) {
    g.node(d.address, "wallet", { tags: ["deposit"] });
    g.node(d.exchange, "wallet", { tags: ["exchange"] });
    moneyEdge(g, cluster.wallet, d.address, sentLabel("Deposited", d.sent), d.sent);
    moneyEdge(g, d.address, d.exchange, sentLabel("Swept", d.swept), d.swept);
    for (const x of d.depositors) {
      g.node(x.wallet, "wallet");
      moneyEdge(g, x.wallet, d.address, sentLabel("Deposited", x), x);
    }
  }
}

/** What a deposit read found, in a line. */
export function depositNote(
  cluster: DepositCluster,
  names: ReadonlyMap<string, string | null> = new Map(),
): string {
  const others = new Set(cluster.deposits.flatMap((d) => d.depositors.map((x) => x.wallet)));
  const cut =
    cluster.stop === "allowance"
      ? " The site's chain reads for today ran short before every wallet it paid was checked."
      : cluster.stop === "paused"
        ? " Chain reads paused before every wallet it paid was checked."
        : "";
  if (cluster.deposits.length === 0)
    return cluster.checked === 0 && !cut
      ? `It sent nothing to any wallet in its recent transactions, so there's no deposit address to check.`
      : `None of the ${cluster.checked} wallet${cluster.checked === 1 ? "" : "s"} it paid most is a deposit address an exchange TrenchScanner knows sweeps.${cut}`;
  const where = cluster.deposits
    .map((d) => `${short(d.address)} (to ${names.get(d.exchange) ?? short(d.exchange)})`)
    .join(", ");
  const n = cluster.deposits.length;
  return (
    `It pays ${n === 1 ? "an exchange deposit address" : `${n} exchange deposit addresses`}: ${where}. ` +
    (others.size === 0
      ? "No other wallet paid into them in their recent transactions."
      : `${others.size} other wallet${others.size === 1 ? "" : "s"} paid into the same address${n === 1 ? "" : "es"}: most likely the same person's exchange account.`) +
    cut
  );
}

// ---------- bridges ----------

/** A wallet's moves through bridges, from its flow read (kept for a day, so often free). */
export function readBridges(
  env: Env,
  helius: Pick<HeliusClient, "getWalletTransactionsPage">,
  userId: string,
  wallet: string,
  now = Date.now(),
): Promise<Chained<WalletFlows>> {
  return metered(env, burnId(userId), FLOW_WORST, () => loadFlows(helius, wallet, now));
}

/** The node a bridge is drawn as: the first of its programs, so Wormhole's two programs are one node. */
export function bridgeNode(bridge: string): string {
  for (const [program, name] of BRIDGE_PROGRAMS) if (name === bridge) return program;
  return bridge;
}

/** Bridge moves drawn: one line per bridge, way and coin, to or from the bridge's node. */
export function addBridges(g: GraphBuilder, wallet: string, moves: readonly WalletFlowBridge[]): void {
  g.node(wallet, "wallet");
  const groups = new Map<string, { m: WalletFlowBridge; total: Moved }>();
  for (const m of moves) {
    const key = `${m.bridge}|${m.dir}|${m.mint ?? ""}`;
    const have = groups.get(key);
    groups.set(key, { m: have?.m ?? m, total: addMove(have?.total ?? none(), m.amount, 1, m.at) });
  }
  for (const { m, total } of groups.values()) {
    const node = bridgeNode(m.bridge);
    g.node(node, "wallet", { tags: ["bridge"] });
    if (m.mint) g.node(m.mint, "token");
    const what = m.mint ? `${fmtAmount(total.sol)} coins` : `${fmtAmount(total.sol)} SOL`;
    const [a, b] = m.dir === "out" ? [wallet, node] : [node, wallet];
    g.edge({
      a,
      b,
      kind: "transfer",
      weight: m.mint ? total.count : total.sol,
      label: [
        `${m.dir === "out" ? "Bridged out" : "Bridged in"} ${what} via ${m.bridge}`,
        total.count > 1 ? `${total.count}×` : null,
        fmtDay(total.lastAt),
      ]
        .filter(Boolean)
        .join(" · "),
      source: "chain",
      mint: m.mint,
      at: total.lastAt === null ? null : new Date(total.lastAt).toISOString(),
      ...(m.mint ? { tokens: total.sol } : { sol: total.sol }),
    });
  }
}

/** What a bridge read found, in a line. */
export function bridgeNote(flows: WalletFlows): string {
  const moves = flows.bridges ?? [];
  if (moves.length === 0)
    return `No bridge moves in its last ${flows.txs} transactions (Wormhole, deBridge, Mayan, Circle CCTP).`;
  const sum = (dir: "in" | "out") => {
    const ms = moves.filter((m) => m.dir === dir);
    if (ms.length === 0) return null;
    const sol = ms.filter((m) => !m.mint).reduce((s, m) => s + m.amount, 0);
    const via = [...new Set(ms.map((m) => m.bridge))].join(", ");
    return `${ms.length} ${dir === "out" ? "out" : "in"}${sol > 0 ? ` (${fmtAmount(sol)} SOL)` : ""} through ${via}`;
  };
  return `${moves.length} bridge move${moves.length === 1 ? "" : "s"} in its last ${flows.txs} transactions: ${[sum("out"), sum("in")].filter(Boolean).join("; ")}. Open each on Solscan to see the other chain.`;
}
