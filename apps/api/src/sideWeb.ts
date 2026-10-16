import { HOT_FUNDER_DENYLIST, prisma } from "@trenchscanner/core";
import { readKolRows } from "./kolRoster.js";
import { loadKolSideLabels, type KolSideLabel } from "./possibleSides.js";
import { loadWalletBundle } from "./walletBundle.js";

/**
 * A wallet's web (user ask 2026-10-16): the bubble map of every wallet labeled for it (a KOL's
 * Known Sides, the wallets it funded and its Possible Sides), or for any other wallet the ones its
 * Multi-Wallet-Bundle would label, each tied to the wallet it is linked to by what linked it.
 * Ties run wallet to wallet where the tables say which one: a wallet a KOL's Known Side funded hangs
 * off that Known Side, and coins moved between two side wallets tie them to each other. A funder
 * outside the web that paid two or more of its wallets shows as a shared funder. A read of what is
 * stored: no outside calls.
 */

/** Wallets the map draws besides the hub; a KOL with more lists its strongest. */
export const SIDE_WEB_MAX = 80;
/** Shared funders drawn at most, those paying the most wallets first. */
export const SIDE_WEB_FUNDERS_MAX = 8;
const TRANSFER_DAYS = 30;

export type WebRole = "hub" | "known" | "funded" | "possible" | "bundle" | "funder";
export type WebTie = "known" | "funded" | "trades" | "transfers";

export interface WebNode {
  wallet: string;
  role: WebRole;
  /** Its name in the export ("Cupsey_2"), the bundle's numbering, or null. */
  name: string | null;
  /** % shared on the tier that labeled it; 0 when transfers or funding alone did. */
  pct: number;
  hours: number;
  /** Transfers with the hub that earned (or helped earn) its label. */
  transfers?: number;
  /** A shared funder: how many of the web's wallets it paid. */
  funds?: number;
}

export interface WebEdge {
  /** The funder, on a funding tie; else either end. */
  from: string;
  to: string;
  type: WebTie;
  /** Trades: % shared and the tier's span. */
  pct?: number;
  hours?: number;
  /** Transfers: coins moved between the two, either way, in 30 days. */
  count?: number;
  /** Funding: the first SOL and when it landed. */
  sol?: number | null;
  at?: string | null;
}

export interface SideWeb {
  wallet: string;
  /** The web's centre: a KOL's main wallet, or the wallet itself. */
  hub: string;
  kol: boolean;
  /** The KOL's name on the roster. */
  name: string | null;
  /** Wallets used: the hub and every wallet labeled for it, drawn or not. */
  total: number;
  counts: { known: number; funded: number; possible: number; bundle: number; transfers: number };
  nodes: WebNode[];
  edges: WebEdge[];
  /** More labeled wallets than SIDE_WEB_MAX: the strongest are drawn. */
  truncated: boolean;
}

/** A labeled wallet as the web reads it, KOL label or bundle alike. */
export interface WebLabel {
  wallet: string;
  role: "known" | "funded" | "possible" | "bundle";
  name: string | null;
  pct: number;
  hours: number;
  transfers?: number;
}

export interface FunderRow {
  wallet: string;
  funder: string;
  amountSol: number | null;
  fundedAt: Date | null;
}

/** sideWeb's pure half: the nodes and ties from what was read. Exported for tests. */
export function buildSideWeb(input: {
  wallet: string;
  hub: string;
  kol: boolean;
  name: string | null;
  labels: readonly WebLabel[];
  funders: readonly FunderRow[];
  /** Transfer counts per pair among the web's wallets, either way. */
  transfers: readonly { a: string; b: string; n: number }[];
  /** Funders that pay too many wallets to tie anything: exchanges and hot wallets. */
  hot: ReadonlySet<string>;
}): SideWeb {
  const { hub, labels } = input;
  const drawn = labels.filter((l) => l.wallet !== hub).slice(0, SIDE_WEB_MAX);
  const inWeb = new Set([hub, ...drawn.map((l) => l.wallet)]);
  const nodes: WebNode[] = [
    { wallet: hub, role: "hub", name: input.name, pct: 0, hours: 0 },
    ...drawn.map((l) => ({
      wallet: l.wallet,
      role: l.role,
      name: l.name,
      pct: l.pct,
      hours: l.hours,
      ...(l.transfers ? { transfers: l.transfers } : {}),
    })),
  ];
  const edges: WebEdge[] = [];
  for (const l of drawn) {
    if (l.role === "known") edges.push({ from: hub, to: l.wallet, type: "known" });
    else if (l.pct > 0) edges.push({ from: hub, to: l.wallet, type: "trades", pct: l.pct, hours: l.hours });
  }
  const fundingOf = (f: FunderRow): WebEdge => ({
    from: f.funder,
    to: f.wallet,
    type: "funded",
    sol: f.amountSol,
    at: f.fundedAt ? f.fundedAt.toISOString() : null,
  });
  // Funding inside the web: whichever of its wallets paid for the first SOL.
  const outside = new Map<string, FunderRow[]>();
  for (const f of input.funders) {
    if (!inWeb.has(f.wallet) || f.funder === f.wallet) continue;
    if (inWeb.has(f.funder)) edges.push(fundingOf(f));
    else if (!input.hot.has(f.funder)) outside.set(f.funder, [...(outside.get(f.funder) ?? []), f]);
  }
  // A funder outside the web that paid two or more of its wallets ties them together.
  const shared = [...outside.entries()]
    .filter(([, rows]) => rows.length >= 2)
    .sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1))
    .slice(0, SIDE_WEB_FUNDERS_MAX);
  for (const [funder, rows] of shared) {
    nodes.push({ wallet: funder, role: "funder", name: null, pct: 0, hours: 0, funds: rows.length });
    for (const f of rows) edges.push(fundingOf(f));
  }
  for (const t of input.transfers) {
    if (t.a === t.b || !inWeb.has(t.a) || !inWeb.has(t.b) || t.n <= 0) continue;
    edges.push({ from: t.a, to: t.b, type: "transfers", count: t.n });
  }
  // A label held past its last 30 days (transfers older than that, or a funder row re-read) still
  // ties to the hub by what earned it, so no wallet floats loose.
  const tied = new Set(edges.flatMap((e) => [e.from, e.to]));
  for (const l of drawn) {
    if (tied.has(l.wallet)) continue;
    if (l.role === "funded") edges.push({ from: hub, to: l.wallet, type: "funded", sol: null, at: null });
    else edges.push({ from: hub, to: l.wallet, type: "transfers", count: l.transfers ?? 0 });
  }
  const count = (role: WebLabel["role"]) => labels.filter((l) => l.role === role).length;
  return {
    wallet: input.wallet,
    hub,
    kol: input.kol,
    name: input.name,
    total: 1 + labels.filter((l) => l.wallet !== hub).length,
    counts: {
      known: count("known"),
      funded: count("funded"),
      possible: count("possible"),
      bundle: count("bundle"),
      transfers: new Set(
        edges.filter((e) => e.type === "transfers").flatMap((e) => [e.from, e.to].filter((w) => w !== hub)),
      ).size,
    },
    nodes,
    edges,
    truncated: labels.length > drawn.length,
  };
}

const fromKolLabel = (l: KolSideLabel): WebLabel => ({
  wallet: l.wallet,
  role: l.kind,
  name: l.name,
  pct: l.kind === "known" ? 0 : l.pct,
  hours: l.hours,
  ...(l.transfers ? { transfers: l.transfers } : {}),
});

/** A wallet's web: a KOL's labeled wallets round its main wallet, or any other wallet's bundle round it. */
export async function loadSideWeb(wallet: string, now = Date.now()): Promise<SideWeb> {
  const roster = await readKolRows([wallet]);
  const row = roster.get(wallet);
  const hub = row?.main?.wallet ?? wallet;
  let name: string | null = null;
  let labels: WebLabel[];
  if (row) {
    name = row.main ? row.main.name : row.name;
    labels = (await loadKolSideLabels(hub)).map(fromKolLabel);
  } else {
    const bundle = await loadWalletBundle(wallet, now);
    labels = bundle.labeled.map((l) => ({
      wallet: l.wallet,
      role: "bundle",
      name: l.name,
      pct: l.pct,
      hours: l.hours,
      ...(l.transfers ? { transfers: l.transfers } : {}),
    }));
  }
  const web = [
    hub,
    ...labels
      .filter((l) => l.wallet !== hub)
      .slice(0, SIDE_WEB_MAX)
      .map((l) => l.wallet),
  ];
  const since = new Date(now - TRANSFER_DAYS * 86_400_000);
  const [funders, transfers] = await Promise.all([
    prisma.walletFunder.findMany({
      where: { wallet: { in: web }, status: "found", funder: { not: null } },
      select: { wallet: true, funder: true, amountSol: true, fundedAt: true },
    }),
    prisma.$queryRaw<{ a: string; b: string; n: number }[]>`
      SELECT LEAST(e."fromWallet", e."toWallet") AS a, GREATEST(e."fromWallet", e."toWallet") AS b,
             COUNT(*)::int AS n
      FROM "HolderTransferEvent" e
      WHERE e."fromWallet" = ANY(${web}) AND e."toWallet" = ANY(${web}) AND e."at" >= ${since}
      GROUP BY 1, 2`,
  ]);
  const outside = [...new Set(funders.map((f) => f.funder!).filter((f) => !web.includes(f)))];
  const hotRows = outside.length
    ? await prisma.funderActivity.findMany({
        where: { address: { in: outside }, hot: true },
        select: { address: true },
      })
    : [];
  return buildSideWeb({
    wallet,
    hub,
    kol: !!row,
    name,
    labels,
    funders: funders.map((f) => ({ ...f, funder: f.funder! })),
    transfers: transfers.map((t) => ({ ...t, n: Number(t.n) })),
    hot: new Set([...HOT_FUNDER_DENYLIST, ...hotRows.map((r) => r.address)]),
  });
}
