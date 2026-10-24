import {
  prisma,
  isHotFunder,
  isServiceWallet,
  HOT_FUNDER_DENYLIST,
  KNOWN_EXCHANGE_WALLETS,
  MARKED_BOT_WALLETS,
  PLATFORM_WALLETS,
  RISKY_WALLET_SCORE,
} from "@trenchscanner/core";
import { loadWalletNames, type WalletName } from "../walletNames.js";
import { loadPossibleSides } from "../possibleSides.js";
import { loadTrackedSides, mergeSides, withTrackedNames, type TrackedWallet } from "../trackedWallets.js";
import type { AsylEdge, AsylGraph, AsylNode, AsylTag } from "./types.js";

/**
 * Asyl's stored-data reads (user ask 2026-10-24): a wallet's or a coin's neighbourhood from what
 * TrenchScanner already keeps, at no Helius cost, for every signed-in user. Each read is a handful
 * of indexed lookups with hard row limits, so a map never holds the database the scan runs on.
 *
 * Where each edge comes from:
 * - funded: WalletFunder (who paid each wallet first). Exchanges and other hot funders aren't
 *   drawn as a shared funder: they pay thousands of strangers.
 * - transfer: HolderTransferEvent (coins moved between top holders, 30 days).
 * - cotrade: TokenWalletActivity, wallets whose first buy of the same coin came within
 *   COTRADE_WINDOW_MS of this wallet's, on COTRADE_MIN_SHARED coins or more.
 * - side: KolWallet.mainWallet (Known Sides), KolPossibleSide, and the reader's own labels'
 *   sides (TrackedWalletSide).
 * - created / traded / holds: Token.creator, TokenWalletActivity, BubbleMapHolders and the scans'
 *   holder lists.
 */

/** Wallets one funder paid, drawn at most (newest first). */
export const FUNDED_MAX = 30;
/** Other wallets the same funder paid, drawn at most. */
export const SIBLINGS_MAX = 20;
/** Counterparties of holder transfers, drawn at most. */
export const TRANSFERS_MAX = 30;
/** Coins a wallet traded or launched, drawn at most (newest first). */
export const COINS_MAX = 24;
/** Its first buys a co-trader search reads, newest first. */
export const COTRADE_COINS = 60;
export const COTRADE_WINDOW_MS = 3 * 60_000;
export const COTRADE_MIN_SHARED = 2;
export const COTRADERS_MAX = 20;
/** Sides of a KOL or a labeled wallet, drawn at most. */
export const SIDES_MAX = 24;
/** Holders drawn on a coin's map: its top 50, as BubbleMapHolders keeps them. */
export const HOLDERS_MAX = 50;
/** How far back the stored tables reach, for the coverage line. */
export const STORED_DAYS = 30;

const fmtSol = (sol: number | null | undefined) =>
  sol === null || sol === undefined
    ? null
    : sol >= 100
      ? `${sol.toFixed(0)} SOL`
      : `${sol.toPrecision(2)} SOL`;
const fmtDay = (d: Date | null | undefined) =>
  d ? d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : null;
const fmtPct = (pct: number) =>
  pct >= 10 ? `${pct.toFixed(0)}%` : pct >= 0.1 ? `${pct.toFixed(1)}%` : `${pct.toFixed(2)}%`;

/** Nodes and edges, each kept once: a node's first sighting, an edge's strongest reading. */
export class GraphBuilder {
  private nodes = new Map<string, AsylNode>();
  private edges = new Map<string, AsylEdge>();

  node(id: string, kind: AsylNode["kind"], extra: Partial<AsylNode> = {}): void {
    const have = this.nodes.get(id);
    if (have) {
      for (const [k, v] of Object.entries(extra)) {
        if (v !== undefined && v !== null && (have as unknown as Record<string, unknown>)[k] == null)
          (have as unknown as Record<string, unknown>)[k] = v;
      }
      return;
    }
    this.nodes.set(id, { id, kind, name: null, tags: [], ...extra });
  }

  edge(e: AsylEdge): void {
    if (e.a === e.b) return;
    // Undirected kinds are keyed in address order, so a pair is one edge whichever end asked.
    const undirected = e.kind === "cotrade";
    const [a, b] = undirected && e.a > e.b ? [e.b, e.a] : [e.a, e.b];
    const key = `${e.kind}|${a}|${b}|${e.mint ?? ""}`;
    const have = this.edges.get(key);
    if (!have || e.weight > have.weight) this.edges.set(key, { ...e, a, b });
  }

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  wallets(): string[] {
    return [...this.nodes.values()].filter((n) => n.kind === "wallet").map((n) => n.id);
  }

  tokens(): string[] {
    return [...this.nodes.values()].filter((n) => n.kind === "token").map((n) => n.id);
  }

  get(id: string): AsylNode | undefined {
    return this.nodes.get(id);
  }

  graph(): AsylGraph {
    return { nodes: [...this.nodes.values()], edges: [...this.edges.values()] };
  }
}

/** Whether a funder is a service (an exchange, a bridge, a bot paying thousands), not a person. */
export async function hotFunders(funders: readonly string[]): Promise<Set<string>> {
  const unique = [...new Set(funders)];
  const out = new Set<string>();
  const ask: string[] = [];
  for (const f of unique) {
    if (HOT_FUNDER_DENYLIST.has(f) || KNOWN_EXCHANGE_WALLETS.has(f) || isServiceWallet(f)) out.add(f);
    else ask.push(f);
  }
  if (ask.length === 0) return out;
  const rows = await prisma.funderActivity.findMany({
    where: { address: { in: ask } },
    select: { address: true, fullPageSpanMs: true },
  });
  for (const r of rows) if (isHotFunder(r.address, { fullPageSpanMs: r.fullPageSpanMs })) out.add(r.address);
  return out;
}

/** The wallet's funder, the wallets it paid, and (for a person funder) the funder's other wallets. */
export async function addFunding(g: GraphBuilder, wallet: string): Promise<void> {
  const [own, paid] = await Promise.all([
    prisma.walletFunder.findUnique({
      where: { wallet },
      select: { status: true, funder: true, amountSol: true, fundedAt: true },
    }),
    prisma.walletFunder.findMany({
      where: { funder: wallet },
      select: { wallet: true, amountSol: true, fundedAt: true },
      orderBy: { fundedAt: "desc" },
      take: FUNDED_MAX,
    }),
  ]);
  for (const p of paid) {
    g.node(p.wallet, "wallet");
    g.edge({
      a: wallet,
      b: p.wallet,
      kind: "funded",
      weight: p.amountSol ?? 0.01,
      label: ["Funded", fmtSol(p.amountSol), fmtDay(p.fundedAt)].filter(Boolean).join(" · "),
      source: "stored",
      at: p.fundedAt?.toISOString() ?? null,
    });
  }
  if (own?.status !== "found" || !own.funder) return;
  const funder = own.funder;
  const hot = (await hotFunders([funder])).has(funder);
  g.node(funder, "wallet", hot ? { tags: ["exchange"] } : {});
  g.edge({
    a: funder,
    b: wallet,
    kind: "funded",
    weight: own.amountSol ?? 0.01,
    label: ["Funded", fmtSol(own.amountSol), fmtDay(own.fundedAt)].filter(Boolean).join(" · "),
    source: "stored",
    at: own.fundedAt?.toISOString() ?? null,
  });
  if (hot) return;
  const siblings = await prisma.walletFunder.findMany({
    where: { funder, wallet: { not: wallet } },
    select: { wallet: true, amountSol: true, fundedAt: true },
    orderBy: { fundedAt: "desc" },
    take: SIBLINGS_MAX,
  });
  for (const s of siblings) {
    g.node(s.wallet, "wallet");
    g.edge({
      a: funder,
      b: s.wallet,
      kind: "funded",
      weight: s.amountSol ?? 0.01,
      label: ["Funded", fmtSol(s.amountSol), fmtDay(s.fundedAt)].filter(Boolean).join(" · "),
      source: "stored",
      at: s.fundedAt?.toISOString() ?? null,
    });
  }
}

/** Coins moved between this wallet and other top holders (30 days), by counterparty and coin. */
export async function addHolderTransfers(g: GraphBuilder, wallet: string): Promise<void> {
  const rows = await prisma.$queryRaw<
    { fromWallet: string; toWallet: string; mintAddress: string; n: number; pct: number; last: Date }[]
  >`
    SELECT "fromWallet", "toWallet", "mintAddress", COUNT(*)::int AS n, SUM("pct")::float AS pct, MAX("at") AS last
      FROM "HolderTransferEvent"
     WHERE "fromWallet" = ${wallet} OR "toWallet" = ${wallet}
     GROUP BY 1, 2, 3
     ORDER BY n DESC, pct DESC
     LIMIT ${TRANSFERS_MAX}`;
  for (const r of rows) {
    g.node(r.fromWallet, "wallet");
    g.node(r.toWallet, "wallet");
    g.node(r.mintAddress, "token");
    g.edge({
      a: r.fromWallet,
      b: r.toWallet,
      kind: "transfer",
      weight: r.pct,
      label: `Sent ${fmtPct(r.pct)} of supply${r.n > 1 ? ` · ${r.n}×` : ""} · ${fmtDay(r.last)}`,
      source: "stored",
      mint: r.mintAddress,
      at: r.last.toISOString(),
    });
  }
}

/** Coins it bought or sold on a read trade tape, and coins it launched. */
export async function addCoins(g: GraphBuilder, wallet: string): Promise<number> {
  const [traded, launched, seen] = await Promise.all([
    prisma.tokenWalletActivity.findMany({
      where: { wallet },
      select: {
        buys: true,
        sells: true,
        solIn: true,
        solOut: true,
        firstBuyAt: true,
        heldPctAtAnchor: true,
        launchSniper: true,
        token: { select: { mintAddress: true } },
      },
      orderBy: { createdAt: "desc" },
      take: COINS_MAX,
    }),
    prisma.token.findMany({
      where: { creator: wallet },
      select: { mintAddress: true, launchedAt: true, firstSeenAt: true },
      orderBy: { firstSeenAt: "desc" },
      take: COINS_MAX,
    }),
    prisma.tokenWalletActivity.count({ where: { wallet } }),
  ]);
  for (const t of traded) {
    const mint = t.token.mintAddress;
    g.node(mint, "token");
    const net = t.solOut - t.solIn;
    g.edge({
      a: wallet,
      b: mint,
      kind: "traded",
      weight: Math.max(t.solIn, t.solOut, 0.01),
      label: [
        `${t.buys} buy${t.buys === 1 ? "" : "s"}, ${t.sells} sell${t.sells === 1 ? "" : "s"}`,
        t.sells > 0 ? `${net >= 0 ? "+" : ""}${net.toFixed(2)} SOL` : `in ${t.solIn.toFixed(2)} SOL`,
        t.launchSniper ? "sniped" : null,
      ]
        .filter(Boolean)
        .join(" · "),
      source: "stored",
      mint,
      at: t.firstBuyAt?.toISOString() ?? null,
    });
  }
  for (const t of launched) {
    g.node(t.mintAddress, "token");
    const at = t.launchedAt ?? t.firstSeenAt;
    g.edge({
      a: wallet,
      b: t.mintAddress,
      kind: "created",
      weight: 1,
      label: `Launched · ${fmtDay(at)}`,
      source: "stored",
      mint: t.mintAddress,
      at: at.toISOString(),
    });
  }
  return seen;
}

export interface CoTrader {
  wallet: string;
  /** Coins both bought within COTRADE_WINDOW_MS of each other. */
  shared: number;
  /** This wallet's coins the search read. */
  of: number;
  /** Median seconds between the two first buys, signed: negative when the co-trader bought first. */
  medianLeadSec: number;
}

/**
 * Wallets that bought the same coins as `wallet` within minutes of it, on COTRADE_MIN_SHARED coins
 * or more, most shared first. Bots that buy nearly every coin are left out. One query over the
 * partial index on (tokenId, firstBuyAt) the side jobs use.
 */
export async function loadCoTraders(wallet: string, limit = COTRADERS_MAX): Promise<CoTrader[]> {
  const windowSec = COTRADE_WINDOW_MS / 1000;
  const rows = await prisma.$queryRaw<{ wallet: string; shared: number; of: number; lead: number }[]>`
    WITH mine AS (
      SELECT "tokenId", "firstBuyAt" FROM "TokenWalletActivity"
       WHERE "wallet" = ${wallet} AND "buys" > 0 AND "firstBuyAt" IS NOT NULL
       ORDER BY "firstBuyAt" DESC LIMIT ${COTRADE_COINS}
    )
    SELECT o."wallet",
           COUNT(DISTINCT o."tokenId")::int AS shared,
           (SELECT COUNT(*)::int FROM mine) AS of,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (o."firstBuyAt" - m."firstBuyAt")))::float AS lead
      FROM mine m
      JOIN "TokenWalletActivity" o
        ON o."tokenId" = m."tokenId" AND o."buys" > 0 AND o."wallet" <> ${wallet}
       AND o."firstBuyAt" BETWEEN m."firstBuyAt" - make_interval(secs => ${windowSec})
                              AND m."firstBuyAt" + make_interval(secs => ${windowSec})
     GROUP BY o."wallet"
    HAVING COUNT(DISTINCT o."tokenId") >= ${COTRADE_MIN_SHARED}
     ORDER BY shared DESC, o."wallet"
     LIMIT ${limit * 2}`;
  const bots = new Set(
    (
      await prisma.sideWalletBot.findMany({
        where: { wallet: { in: rows.map((r) => r.wallet) } },
        select: { wallet: true },
      })
    ).map((b) => b.wallet),
  );
  return rows
    .filter((r) => !bots.has(r.wallet) && !MARKED_BOT_WALLETS.has(r.wallet) && !isServiceWallet(r.wallet))
    .slice(0, limit)
    .map((r) => ({ wallet: r.wallet, shared: r.shared, of: r.of, medianLeadSec: Math.round(r.lead) }));
}

export function addCoTraders(g: GraphBuilder, wallet: string, coTraders: readonly CoTrader[]): void {
  for (const c of coTraders) {
    g.node(c.wallet, "wallet");
    g.edge({
      a: wallet,
      b: c.wallet,
      kind: "cotrade",
      weight: c.shared,
      label: `Bought ${c.shared} of the same coins within ${COTRADE_WINDOW_MS / 60_000} min`,
      source: "stored",
    });
  }
}

/**
 * Side ties both ways: the KOLs (and the reader's labels) this wallet is a side of, and, for a KOL
 * or a labeled wallet, its sides.
 */
export async function addSides(
  g: GraphBuilder,
  wallet: string,
  tracked: readonly TrackedWallet[],
): Promise<void> {
  const labeled = tracked.find((t) => t.wallet === wallet);
  const [base, own, known, kolSides, trackedSides] = await Promise.all([
    loadPossibleSides([wallet]),
    loadTrackedSides(tracked, [wallet]).catch(() => ({})),
    prisma.kolWallet.findMany({ where: { mainWallet: wallet }, select: { wallet: true }, take: SIDES_MAX }),
    prisma.kolPossibleSide.findMany({
      where: { kolWallet: wallet },
      orderBy: [{ pct: "desc" }, { shared: "desc" }],
      take: SIDES_MAX,
    }),
    labeled
      ? prisma.trackedWalletSide.findMany({
          where: { trackedWallet: wallet },
          orderBy: [{ pct: "desc" }, { shared: "desc" }],
          take: SIDES_MAX,
        })
      : Promise.resolve([]),
  ]);
  const ofIt = mergeSides(base, own, tracked)[wallet] ?? [];
  for (const s of ofIt) {
    g.node(s.kolWallet, "wallet");
    g.edge({
      a: s.kolWallet,
      b: wallet,
      kind: "side",
      weight: s.known ? 100 : s.pct || 1,
      label: s.known
        ? "Known Side"
        : s.funded
          ? `Funded side${s.pct > 0 ? ` · bought ${Math.round(s.pct)}% alongside` : ""}`
          : s.pct > 0
            ? `Probable Side · bought ${Math.round(s.pct)}% of its coins alongside`
            : `Probable Side · ${s.transfers ?? 0} transfers`,
      source: "stored",
    });
  }
  for (const k of known) {
    g.node(k.wallet, "wallet");
    g.edge({ a: wallet, b: k.wallet, kind: "side", weight: 100, label: "Known Side", source: "stored" });
  }
  for (const s of [...kolSides, ...trackedSides]) {
    if (MARKED_BOT_WALLETS.has(s.wallet)) continue;
    g.node(s.wallet, "wallet");
    g.edge({
      a: wallet,
      b: s.wallet,
      kind: "side",
      weight: s.pct || 1,
      label:
        s.pct > 0
          ? `Probable Side · bought ${Math.round(s.pct)}% of its coins alongside`
          : `Probable Side · ${s.transfers} transfers`,
      source: "stored",
    });
  }
}

/** The holders of a coin as TrenchScanner last read them: its bubble map, else the newest scan's list. */
export async function loadStoredHolders(mint: string): Promise<{
  holders: { wallet: string; pct: number }[];
  readAt: Date | null;
  source: "map" | "scan" | null;
}> {
  const map = await prisma.bubbleMapHolders.findUnique({
    where: { mintAddress: mint },
    select: { holders: true, readAt: true },
  });
  if (map && Array.isArray(map.holders)) {
    return {
      holders: (map.holders as { wallet: string; pct: number }[]).slice(0, HOLDERS_MAX),
      readAt: map.readAt,
      source: "map",
    };
  }
  const token = await prisma.token.findUnique({ where: { mintAddress: mint }, select: { id: true } });
  if (!token) return { holders: [], readAt: null, source: null };
  // The newest scan row that carries a list: rows between list writes hold null (holderListWrites.ts).
  const [snap] = await prisma.$queryRaw<{ linkedHolders: unknown; takenAt: Date }[]>`
    SELECT "linkedHolders", "takenAt" FROM "TokenSnapshot"
     WHERE "tokenId" = ${token.id} AND "linkedHolders" IS NOT NULL
     ORDER BY "takenAt" DESC LIMIT 1`;
  const list = Array.isArray(snap?.linkedHolders) ? (snap.linkedHolders as unknown[]) : [];
  const holders = list
    .map((h) => h as { wallet?: unknown; pct?: unknown })
    .map((h) => ({ wallet: String(h.wallet ?? ""), pct: Number(h.pct ?? 0) }))
    .filter((h) => h.wallet.length > 0 && Number.isFinite(h.pct));
  return {
    holders: holders.slice(0, HOLDERS_MAX),
    readAt: snap?.takenAt ?? null,
    source: holders.length ? "scan" : null,
  };
}

/** A coin, its holders as "holds" edges, and every funding and transfer that ties them together. */
export async function addHolders(
  g: GraphBuilder,
  mint: string,
  holders: readonly { wallet: string; pct: number }[],
  source: "stored" | "chain",
): Promise<void> {
  g.node(mint, "token");
  for (const h of holders) {
    g.node(h.wallet, "wallet");
    g.edge({
      a: h.wallet,
      b: mint,
      kind: "holds",
      weight: h.pct,
      label: `Holds ${fmtPct(h.pct)}`,
      source,
      mint,
    });
  }
  const wallets = holders.map((h) => h.wallet);
  if (wallets.length === 0) return;
  const [funders, transfers] = await Promise.all([
    prisma.walletFunder.findMany({
      where: { wallet: { in: wallets }, status: "found" },
      select: { wallet: true, funder: true, amountSol: true, fundedAt: true },
    }),
    prisma.$queryRaw<{ fromWallet: string; toWallet: string; n: number; pct: number; last: Date }[]>`
      SELECT "fromWallet", "toWallet", COUNT(*)::int AS n, SUM("pct")::float AS pct, MAX("at") AS last
        FROM "HolderTransferEvent"
       WHERE "mintAddress" = ${mint} AND "fromWallet" = ANY(${wallets}) AND "toWallet" = ANY(${wallets})
       GROUP BY 1, 2`,
  ]);
  const hot = await hotFunders(funders.flatMap((f) => (f.funder ? [f.funder] : [])));
  // A funder shared by two holders or more, or a holder that paid another, ties them; a funder
  // that paid only one holder adds nothing to the map.
  const byFunder = new Map<string, typeof funders>();
  for (const f of funders)
    if (f.funder && !hot.has(f.funder)) byFunder.set(f.funder, [...(byFunder.get(f.funder) ?? []), f]);
  const onMap = new Set(wallets);
  for (const [funder, paid] of byFunder) {
    if (paid.length < 2 && !onMap.has(funder)) continue;
    g.node(funder, "wallet");
    for (const p of paid)
      g.edge({
        a: funder,
        b: p.wallet,
        kind: "funded",
        weight: p.amountSol ?? 0.01,
        label: ["Funded", fmtSol(p.amountSol), fmtDay(p.fundedAt)].filter(Boolean).join(" · "),
        source: "stored",
        at: p.fundedAt?.toISOString() ?? null,
      });
  }
  for (const t of transfers)
    g.edge({
      a: t.fromWallet,
      b: t.toWallet,
      kind: "transfer",
      weight: t.pct,
      label: `Sent ${fmtPct(t.pct)} of supply${t.n > 1 ? ` · ${t.n}×` : ""} · ${fmtDay(t.last)}`,
      source: "stored",
      mint,
      at: t.last.toISOString(),
    });
}

/** The tags TrenchScanner's own tables give a wallet, from its scores and the lists it is on. */
export function walletTags(input: {
  name?: WalletName | null;
  risk?: { score: number; dumper: boolean; winner: boolean; sniper: boolean } | null;
  dev?: boolean;
  bot?: boolean;
  farm?: boolean;
  exchange?: boolean;
}): AsylTag[] {
  const tags = new Set<AsylTag>();
  if (input.name?.mine) tags.add("mine");
  if (input.name?.source === "kol") tags.add("kol");
  if (input.name?.source === "kol-side") tags.add("kol-side");
  if (input.name?.source === "exchange" || input.name?.service || input.exchange) tags.add("exchange");
  if (input.dev) tags.add("dev");
  if (input.risk?.dumper) tags.add("dumper");
  if (input.risk?.winner) tags.add("winner");
  if (input.risk?.sniper) tags.add("sniper");
  if (input.risk && input.risk.score >= RISKY_WALLET_SCORE && !input.risk.dumper) tags.add("risky");
  if (input.bot) tags.add("bot");
  if (input.farm) tags.add("farm");
  return [...tags];
}

/**
 * Names, tags and scores for every node on the graph, the reader's own labels over TrenchScanner's
 * names (Pro Mode). Database only: Helius is never asked for a name here.
 */
export async function decorate(g: GraphBuilder, tracked: readonly TrackedWallet[]): Promise<AsylGraph> {
  const wallets = g.wallets();
  const tokens = g.tokens();
  const [names, risks, devs, bots, farms, coins] = await Promise.all([
    wallets.length ? loadWalletNames(wallets, null).then((r) => r.names) : Promise.resolve({}),
    wallets.length
      ? prisma.walletRisk.findMany({
          where: { wallet: { in: wallets } },
          select: {
            wallet: true,
            score: true,
            winScore: true,
            dumper: true,
            winner: true,
            sniper: true,
            appearances: true,
            medianPnlSol: true,
          },
        })
      : Promise.resolve([]),
    wallets.length
      ? prisma.devLaunchRisk.findMany({ where: { wallet: { in: wallets } }, select: { wallet: true } })
      : Promise.resolve([]),
    wallets.length
      ? prisma.sideWalletBot.findMany({ where: { wallet: { in: wallets } }, select: { wallet: true } })
      : Promise.resolve([]),
    wallets.length
      ? prisma.devFunderRisk.findMany({ where: { funder: { in: wallets } }, select: { funder: true } })
      : Promise.resolve([]),
    tokens.length
      ? prisma.token.findMany({
          where: { mintAddress: { in: tokens } },
          select: {
            mintAddress: true,
            symbol: true,
            name: true,
            imageUrl: true,
            liveMarketCapUsd: true,
            lastMcapUsd: true,
            launchedAt: true,
            creator: true,
            peakWatch: { select: { athMcapUsd: true } },
          },
        })
      : Promise.resolve([]),
  ]);
  const named = withTrackedNames(names as Record<string, WalletName>, tracked, wallets);
  const riskOf = new Map(risks.map((r) => [r.wallet, r]));
  const devSet = new Set(devs.map((d) => d.wallet));
  const creators = new Set(coins.flatMap((c) => (c.creator ? [c.creator] : [])));
  const botSet = new Set([...bots.map((b) => b.wallet), ...wallets.filter((w) => MARKED_BOT_WALLETS.has(w))]);
  const farmSet = new Set(farms.map((f) => f.funder));
  for (const w of wallets) {
    const n = g.get(w)!;
    const name = named[w] ?? null;
    const r = riskOf.get(w);
    n.name = name?.name ?? PLATFORM_WALLETS.get(w) ?? KNOWN_EXCHANGE_WALLETS.get(w) ?? null;
    const tags = walletTags({
      name,
      risk: r ?? null,
      dev: devSet.has(w) || creators.has(w),
      bot: botSet.has(w),
      farm: farmSet.has(w),
      exchange: KNOWN_EXCHANGE_WALLETS.has(w),
    });
    n.tags = [...new Set([...n.tags, ...tags])];
    if (name?.avatar) n.avatar = name.avatar;
    if (r) {
      n.risk = Math.round(r.score);
      n.win = Math.round(r.winScore);
      n.coins = r.appearances;
      n.medianPnlSol = r.medianPnlSol;
    }
  }
  for (const c of coins) {
    const n = g.get(c.mintAddress);
    if (!n) continue;
    n.name = c.symbol ? `$${c.symbol}` : n.name;
    n.title = c.name;
    n.image = c.imageUrl;
    n.mcapUsd = c.liveMarketCapUsd ?? c.lastMcapUsd;
    n.athUsd = c.peakWatch?.athMcapUsd ?? null;
    n.launchedAt = c.launchedAt?.toISOString() ?? null;
  }
  return g.graph();
}
