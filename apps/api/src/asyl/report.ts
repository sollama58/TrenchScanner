import { prisma } from "@trenchscanner/core";
import { readTokenProfile, type TokenProfile } from "../tokenProfile.js";
import { GraphBuilder, deployedEdge, fundedEdge, hotFunders, tradedEdge } from "./graph.js";

/**
 * A coin's report (user ask 2026-10-26, "add in all of your recommendations"): the bundle and
 * sniper check and the dev's history, in one stored-data read for the inspector. Database only,
 * so free of credits.
 *
 * - Launch: the first 25 buyers on its read trade tape (TokenWalletActivity.firstBuyerRank), how
 *   many sniped in the first 5 seconds, what they bought and still held, and which of them one
 *   person funded (WalletFunder; exchanges and other hot funders aren't a shared owner).
 * - Scan: the newest scan's own bundle readings (TokenSnapshot), each from the newest row that
 *   carries it, since the linked and block-zero readings are written only when they change.
 * - Dev: the token modal's Dev card (readTokenProfile), and whether the dev sold this coin.
 */

/** First buyers read, at most: the tape ranks the first 25. */
export const EARLY_BUYERS_MAX = 25;

export interface EarlyBuyer {
  wallet: string;
  rank: number;
  sniper: boolean;
  solIn: number;
  solOut: number;
  /** % of supply it bought, and held at the tape's anchor. */
  boughtPct: number | null;
  heldPct: number | null;
  sold: boolean;
  funder: string | null;
}

export interface FunderGroup {
  funder: string;
  wallets: string[];
  /** % of supply its wallets held at the tape's anchor. */
  heldPct: number;
}

/** Sells this close together count as one wave (user ask 2026-10-26: coordinated sells). */
export const SELL_WAVE_GAP_MS = 60_000;
/** Wallets a wave needs. */
export const SELL_WAVE_MIN = 3;
/** Waves listed, biggest first. */
export const SELL_WAVES_MAX = 5;
/** Sellers read, at most. */
const SELLERS_READ = 3_000;

export interface SellWave {
  /** The first and last first-sell in it (ISO). */
  from: string;
  to: string;
  wallets: string[];
  /** SOL they took out of the coin in all (every sell, not only the wave's). */
  sol: number;
}

/**
 * Wallets that first sold the coin within SELL_WAVE_GAP_MS of the one before, in runs of
 * SELL_WAVE_MIN or more: a group dumping together, the sell-side twin of "bought together".
 */
export function sellWaves(sells: readonly { wallet: string; at: Date; solOut: number }[]): SellWave[] {
  const sorted = [...sells].sort((a, b) => a.at.getTime() - b.at.getTime());
  const waves: (typeof sorted)[] = [];
  for (const s of sorted) {
    const run = waves[waves.length - 1];
    const last = run?.[run.length - 1];
    if (run && last && s.at.getTime() - last.at.getTime() <= SELL_WAVE_GAP_MS) run.push(s);
    else waves.push([s]);
  }
  return waves
    .filter((w) => w.length >= SELL_WAVE_MIN)
    .map((w) => ({
      from: w[0]!.at.toISOString(),
      to: w[w.length - 1]!.at.toISOString(),
      wallets: w.map((x) => x.wallet),
      sol: sum(w.map((x) => x.solOut)),
    }))
    .sort((a, b) => b.wallets.length - a.wallets.length || b.sol - a.sol)
    .slice(0, SELL_WAVES_MAX);
}

/** Points in the holders-over-time chart, at most, spread evenly over the scans read. */
export const CONCENTRATION_POINTS = 48;
/** Scans the chart reads, newest first. */
const CONCENTRATION_READ = 600;

export interface ConcentrationPoint {
  at: string;
  /** Supply the ten largest holders held, pools aside. */
  top10: number | null;
  /** Supply the single largest holder held. */
  largest: number | null;
  /** Supply in linked top holders (Bundled %). */
  bundled: number | null;
  holders: number | null;
}

/** Spreads `n` picks evenly over a list, keeping its first and last. */
export function spread<T>(xs: readonly T[], n: number): T[] {
  if (xs.length <= n) return [...xs];
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(xs[Math.round((i * (xs.length - 1)) / (n - 1))]!);
  return out;
}

/**
 * Who put SOL into a coin and who took it out, by wallet group (user ask 2026-10-26, "token
 * flow"). Each wallet counts in its first group: the dev, launch snipers (first 5 seconds), the
 * rest of the first 25 buyers, the top ten holders at the tape's anchor, and everyone else.
 */
export type FlowGroup = "dev" | "sniper" | "early" | "top" | "rest";
export interface FlowRow {
  group: FlowGroup;
  wallets: number;
  solIn: number;
  solOut: number;
}

export interface BundleVerdict {
  level: "high" | "some" | "low" | "unknown";
  text: string;
}

export interface CoinReport {
  mint: string;
  launch: {
    buyers: EarlyBuyer[];
    snipers: number;
    boughtPct: number;
    heldPct: number;
    soldCount: number;
    groups: FunderGroup[];
    /** Early buyers whose funder was read. */
    fundersRead: number;
  } | null;
  scan: {
    at: string;
    bundledPct: number | null;
    bundledCount: number | null;
    holdersChecked: number | null;
    blockZeroBuyers: number | null;
    blockZeroHeldPct: number | null;
    blockZeroBoughtPct: number | null;
    snipersInTop: number | null;
    topChecked: number | null;
    freshInTop: number | null;
    freshChecked: number | null;
    cexFundedPct: number | null;
    devHolding: boolean | null;
  } | null;
  verdict: BundleVerdict;
  /** Groups that sold together, biggest first. */
  waves: SellWave[];
  /** Holder concentration at each scan, oldest first. */
  concentration: ConcentrationPoint[];
  /** SOL in and out by wallet group, from the coin's trade tape; empty when it wasn't read. */
  flow: FlowRow[];
  dev:
    | (NonNullable<TokenProfile["dev"]> & {
        /** What the dev did with this coin on its trade tape; null when the tape didn't see it trade. */
        thisCoin: { solIn: number; solOut: number; sold: boolean; firstSellAt: string | null } | null;
      })
    | null;
}

const sum = (xs: (number | null)[]) => xs.reduce<number>((s, x) => s + (x ?? 0), 0);
const pct = (n: number) => (n >= 10 ? n.toFixed(0) : n.toFixed(1));

/**
 * One line a trader can act on. The scan's Bundled % (linked top holders and KOL bundles) is the
 * best reading; without it, what one funder's early buyers still held stands in.
 */
export function bundleVerdict(
  scan: Pick<NonNullable<CoinReport["scan"]>, "bundledPct" | "blockZeroHeldPct"> | null,
  launch: Pick<NonNullable<CoinReport["launch"]>, "groups" | "snipers" | "buyers"> | null,
): BundleVerdict {
  const bundled = scan?.bundledPct ?? null;
  const block0 = scan?.blockZeroHeldPct ?? null;
  const grouped = launch ? sum(launch.groups.map((g) => g.heldPct)) : null;
  const groupedWallets = launch ? launch.groups.reduce((n, g) => n + g.wallets.length, 0) : 0;
  if (bundled === null && block0 === null && (launch === null || launch.buyers.length === 0))
    return {
      level: "unknown",
      text: "No bundle reading yet: TrenchScanner hasn't read this coin's holders or launch.",
    };
  const worst = Math.max(bundled ?? 0, block0 ?? 0, grouped ?? 0);
  const parts: string[] = [];
  if (bundled !== null) parts.push(`${pct(bundled)}% of supply is in linked wallets`);
  if (block0 !== null && block0 > 0) parts.push(`block-0 snipers hold ${pct(block0)}%`);
  if (groupedWallets > 0 && grouped !== null)
    parts.push(
      `${groupedWallets} of the first buyers share a funder${grouped > 0 ? ` and held ${pct(grouped)}%` : ""}`,
    );
  else if (launch && launch.snipers > 0) parts.push(`${launch.snipers} wallets sniped the first 5 seconds`);
  const level = worst >= 25 ? "high" : worst >= 10 || groupedWallets >= 3 ? "some" : "low";
  const lead = level === "high" ? "Bundled" : level === "some" ? "Partly bundled" : "Little bundling";
  return { level, text: parts.length ? `${lead}: ${parts.join("; ")}.` : `${lead}.` };
}

/** The newest value of each scan reading, taken from the newest row that carries it. */
async function scanReadings(tokenId: string): Promise<CoinReport["scan"]> {
  const [linked, block0, top, last] = await Promise.all([
    prisma.tokenSnapshot.findFirst({
      where: { tokenId, bundledSupplyPct: { not: null } },
      orderBy: { takenAt: "desc" },
      select: {
        bundledSupplyPct: true,
        bundledSupplyCount: true,
        linkedWalletsChecked: true,
        cexFundedPct: true,
      },
    }),
    prisma.tokenSnapshot.findFirst({
      where: { tokenId, blockZeroBuyers: { not: null } },
      orderBy: { takenAt: "desc" },
      select: { blockZeroBuyers: true, blockZeroHeldPct: true, blockZeroBoughtPct: true },
    }),
    prisma.tokenSnapshot.findFirst({
      where: {
        tokenId,
        OR: [{ sniperTopHolderCount: { not: null } }, { freshTopHolderCount: { not: null } }],
      },
      orderBy: { takenAt: "desc" },
      select: {
        sniperTopHolderCount: true,
        sniperTopHoldersChecked: true,
        freshTopHolderCount: true,
        freshTopHoldersChecked: true,
      },
    }),
    prisma.tokenSnapshot.findFirst({
      where: { tokenId },
      orderBy: { takenAt: "desc" },
      select: { takenAt: true, devHolding: true },
    }),
  ]);
  if (!last) return null;
  return {
    at: last.takenAt.toISOString(),
    bundledPct: linked?.bundledSupplyPct ?? null,
    bundledCount: linked?.bundledSupplyCount ?? null,
    holdersChecked: linked?.linkedWalletsChecked ?? null,
    blockZeroBuyers: block0?.blockZeroBuyers ?? null,
    blockZeroHeldPct: block0?.blockZeroHeldPct ?? null,
    blockZeroBoughtPct: block0?.blockZeroBoughtPct ?? null,
    snipersInTop: top?.sniperTopHolderCount ?? null,
    topChecked: top?.sniperTopHoldersChecked ?? null,
    freshInTop: top?.freshTopHolderCount ?? null,
    freshChecked: top?.freshTopHoldersChecked ?? null,
    cexFundedPct: linked?.cexFundedPct ?? null,
    devHolding: last.devHolding,
  };
}

const earlySelect = {
  wallet: true,
  firstBuyerRank: true,
  launchSniper: true,
  buys: true,
  sells: true,
  solIn: true,
  solOut: true,
  firstBuyAt: true,
  boughtPct: true,
  heldPctAtAnchor: true,
} as const;

/** The coin's first buyers on its tape, with their funders, and the funders that paid two or more. */
async function launchReading(tokenId: string): Promise<CoinReport["launch"]> {
  const rows = await prisma.tokenWalletActivity.findMany({
    where: { tokenId, firstBuyerRank: { not: null } },
    orderBy: { firstBuyerRank: "asc" },
    take: EARLY_BUYERS_MAX,
    select: earlySelect,
  });
  if (rows.length === 0) return null;
  const funders = await prisma.walletFunder.findMany({
    where: { wallet: { in: rows.map((r) => r.wallet) }, status: "found" },
    select: { wallet: true, funder: true },
  });
  const funderOf = new Map(funders.filter((f) => f.funder).map((f) => [f.wallet, f.funder!]));
  const hot = await hotFunders([...funderOf.values()]);
  const buyers: EarlyBuyer[] = rows.map((r) => ({
    wallet: r.wallet,
    rank: r.firstBuyerRank!,
    sniper: r.launchSniper,
    solIn: r.solIn,
    solOut: r.solOut,
    boughtPct: r.boughtPct,
    heldPct: r.heldPctAtAnchor,
    sold: r.sells > 0,
    funder: funderOf.get(r.wallet) ?? null,
  }));
  const byFunder = new Map<string, EarlyBuyer[]>();
  for (const b of buyers) {
    if (!b.funder || hot.has(b.funder)) continue;
    byFunder.set(b.funder, [...(byFunder.get(b.funder) ?? []), b]);
  }
  // One of the buyers paying the others counts as the same person too.
  for (const b of buyers) {
    const paid = byFunder.get(b.wallet);
    if (paid && !paid.includes(b)) paid.unshift(b);
  }
  const groups = [...byFunder.entries()]
    .filter(([, ws]) => ws.length >= 2)
    .map(([funder, ws]) => ({
      funder,
      wallets: ws.map((w) => w.wallet),
      heldPct: sum(ws.map((w) => w.heldPct)),
    }))
    .sort((a, b) => b.wallets.length - a.wallets.length || b.heldPct - a.heldPct);
  return {
    buyers,
    snipers: buyers.filter((b) => b.sniper).length,
    boughtPct: sum(buyers.map((b) => b.boughtPct)),
    heldPct: sum(buyers.map((b) => b.heldPct)),
    soldCount: buyers.filter((b) => b.sold).length,
    groups,
    fundersRead: funderOf.size,
  };
}

async function concentrationSeries(tokenId: string): Promise<ConcentrationPoint[]> {
  const rows = await prisma.tokenSnapshot.findMany({
    where: {
      tokenId,
      OR: [
        { top10HolderPct: { not: null } },
        { largestHolderPct: { not: null } },
        { bundledSupplyPct: { not: null } },
      ],
    },
    orderBy: { takenAt: "desc" },
    take: CONCENTRATION_READ,
    select: {
      takenAt: true,
      top10HolderPct: true,
      largestHolderPct: true,
      bundledSupplyPct: true,
      holderCount: true,
    },
  });
  return spread(rows.reverse(), CONCENTRATION_POINTS).map((r) => ({
    at: r.takenAt.toISOString(),
    top10: r.top10HolderPct,
    largest: r.largestHolderPct,
    bundled: r.bundledSupplyPct,
    holders: r.holderCount,
  }));
}

const FLOW_ORDER: readonly FlowGroup[] = ["dev", "sniper", "early", "top", "rest"];

async function moneyFlow(tokenId: string): Promise<FlowRow[]> {
  const rows = await prisma.$queryRaw<{ grp: FlowGroup; wallets: number; sol_in: number; sol_out: number }[]>`
    SELECT CASE WHEN "isCreator" THEN 'dev'
                WHEN "launchSniper" THEN 'sniper'
                WHEN "firstBuyerRank" IS NOT NULL THEN 'early'
                WHEN "top10AtAnchor" THEN 'top'
                ELSE 'rest' END AS grp,
           COUNT(*)::int AS wallets,
           COALESCE(SUM("solIn"), 0)::float AS sol_in,
           COALESCE(SUM("solOut"), 0)::float AS sol_out
      FROM "TokenWalletActivity"
     WHERE "tokenId" = ${tokenId}
     GROUP BY 1`;
  return rows
    .map((r) => ({ group: r.grp, wallets: r.wallets, solIn: r.sol_in, solOut: r.sol_out }))
    .filter((r) => r.solIn > 0 || r.solOut > 0)
    .sort((a, b) => FLOW_ORDER.indexOf(a.group) - FLOW_ORDER.indexOf(b.group));
}

export async function loadCoinReport(mint: string): Promise<CoinReport | null> {
  const token = await prisma.token.findUnique({ where: { mintAddress: mint }, select: { id: true } });
  if (!token) return null;
  const [launch, scan, profile, sellers, concentration, flow] = await Promise.all([
    launchReading(token.id),
    scanReadings(token.id),
    readTokenProfile(mint),
    prisma.tokenWalletActivity.findMany({
      where: { tokenId: token.id, firstSellAt: { not: null } },
      orderBy: { firstSellAt: "asc" },
      take: SELLERS_READ,
      select: { wallet: true, firstSellAt: true, solOut: true },
    }),
    concentrationSeries(token.id),
    moneyFlow(token.id),
  ]);
  const dev = profile?.dev ?? null;
  const own = dev
    ? await prisma.tokenWalletActivity.findUnique({
        where: { tokenId_wallet: { tokenId: token.id, wallet: dev.wallet } },
        select: { solIn: true, solOut: true, sells: true, firstSellAt: true },
      })
    : null;
  return {
    mint,
    launch,
    scan,
    verdict: bundleVerdict(scan, launch),
    waves: sellWaves(sellers.map((r) => ({ wallet: r.wallet, at: r.firstSellAt!, solOut: r.solOut }))),
    concentration,
    flow,
    dev: dev
      ? {
          ...dev,
          thisCoin: own
            ? {
                solIn: own.solIn,
                solOut: own.solOut,
                sold: own.sells > 0,
                firstSellAt: own.firstSellAt?.toISOString() ?? null,
              }
            : null,
        }
      : null,
  };
}

/** The coin's first buyers on the map: what each traded, and who funded them. */
export async function addEarlyBuyers(g: GraphBuilder, mint: string): Promise<number> {
  const token = await prisma.token.findUnique({ where: { mintAddress: mint }, select: { id: true } });
  if (!token) return 0;
  const rows = await prisma.tokenWalletActivity.findMany({
    where: { tokenId: token.id, firstBuyerRank: { not: null } },
    orderBy: { firstBuyerRank: "asc" },
    take: EARLY_BUYERS_MAX,
    select: earlySelect,
  });
  g.node(mint, "token");
  for (const r of rows) {
    g.node(r.wallet, "wallet");
    tradedEdge(g, r.wallet, mint, r);
  }
  const funders = rows.length
    ? await prisma.walletFunder.findMany({
        where: { wallet: { in: rows.map((r) => r.wallet) }, status: "found" },
        select: { wallet: true, funder: true, amountSol: true, fundedAt: true },
      })
    : [];
  const hot = await hotFunders(funders.map((f) => f.funder).filter((f): f is string => !!f));
  for (const f of funders) {
    if (!f.funder) continue;
    g.node(f.funder, "wallet", hot.has(f.funder) ? { tags: ["exchange"] } : {});
    fundedEdge(g, f.funder, f.wallet, f);
  }
  return rows.length;
}

/** Every coin a wallet deployed that TrenchScanner knows of, newest first, as "created" lines. */
export const LAUNCHES_MAX = 40;
export async function addLaunches(g: GraphBuilder, wallet: string): Promise<number> {
  const [made, taped] = await Promise.all([
    prisma.token.findMany({
      where: { OR: [{ deployer: wallet }, { deployer: null, creator: wallet }] },
      select: { mintAddress: true, launchedAt: true, firstSeenAt: true },
      orderBy: { firstSeenAt: "desc" },
      take: LAUNCHES_MAX,
    }),
    prisma.tokenWalletActivity.findMany({
      where: { wallet, isCreator: true },
      select: { token: { select: { mintAddress: true, launchedAt: true, firstSeenAt: true } } },
      orderBy: { createdAt: "desc" },
      take: LAUNCHES_MAX,
    }),
  ]);
  g.node(wallet, "wallet", { tags: ["dev"] });
  const seen = new Set<string>();
  for (const t of [...made, ...taped.map((x) => x.token)]) {
    if (seen.has(t.mintAddress) || seen.size >= LAUNCHES_MAX) continue;
    seen.add(t.mintAddress);
    g.node(t.mintAddress, "token");
    deployedEdge(g, wallet, t.mintAddress, t.launchedAt ?? t.firstSeenAt);
  }
  return seen.size;
}
