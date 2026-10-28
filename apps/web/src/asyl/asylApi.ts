import { api, del, post, put, API_URL } from "../api";
import type { AsylGraph, Cutoffs, Drawings, TimeLabels } from "./graph";

/** The calls Asyl makes (apps/api/src/routes/asyl.ts). */

export interface Allowance {
  enabled: boolean;
  used: number;
  cap: number;
  globalUsed: number;
  globalCap: number;
  left: number;
  resetsAt: string;
}

export interface AsylMe {
  wallet: string;
  pro: boolean;
  /** An admin, who can take a shared map's link down. */
  admin?: boolean;
  chain: Allowance | null;
  /**
   * The reader's Burn Credits (null when they couldn't be read): what the paid chain tools take.
   * `freeLeft` is a subscriber's free credits left today, null without a subscription.
   */
  burn?: { balance: number; freeLeft: number | null; cost: { deposits: number; bridges: number } } | null;
  /** SOL's price in USD, for the USD slider; null when no source answered. */
  solUsd?: number | null;
  labels: { cap: number; nameMax: number };
}

export interface Coverage {
  seen: number;
  days: number;
  chainAvailable: boolean;
  note: string;
}

export interface GraphRead {
  focus: string | null;
  graph: AsylGraph;
  coverage?: Coverage;
}

export interface ChainRead extends GraphRead {
  credits: number;
  cached: boolean;
  allowance: Allowance;
  flows?: { txs: number; fromMs: number | null; toMs: number | null };
}

/** What a paid chain tool took: `cost` Burn Credits (0 when re-opened within the hour), `free` of them from today's. */
export interface BurnSpend {
  cost: number;
  free: number;
  balance: number;
  freeLeft: number;
  reopened: boolean;
}

export interface DepositAddress {
  address: string;
  exchange: string;
  depositors: { wallet: string }[];
}

export interface BridgeMove {
  bridge: string;
  dir: "in" | "out";
  mint: string | null;
  amount: number;
  at: number | null;
  signature: string | null;
}

export interface CoTrader {
  wallet: string;
  shared: number;
  of: number;
  medianLeadSec: number;
  medianGapSec: number;
}

export interface SimilarRead extends GraphRead {
  coTraders: CoTrader[];
  /** Every co-trader there is (up to 500); coTraders holds the first 20 unless all were asked. */
  total?: number;
  coins: { mint: string; buyers: number; firstBuyAt: string | null }[];
}

/** The search box's answer (apps/api/src/asyl/search.ts). */
export interface SearchRead {
  q: string;
  tokens: {
    mint: string;
    symbol: string | null;
    name: string | null;
    image: string | null;
    mcapUsd: number | null;
    launchedAt: string | null;
  }[];
  wallets: {
    wallet: string;
    name: string;
    kind: "kol" | "label";
    twitter: string | null;
    avatar: string | null;
    winRate: number | null;
    pnlUsd: number | null;
  }[];
}

/** The trades behind a bought-together link (apps/api/src/asyl/cotrade.ts). */
export type PairTrade = [number, 1 | -1, number, number];
export interface PairSide {
  firstBuyAt: string;
  firstSellAt: string | null;
  buys: number;
  sells: number;
  solIn: number;
  solOut: number;
  netSol: number;
  boughtPct: number | null;
  firstBuyerRank: number | null;
  sniper: boolean;
  fastExit: boolean;
  trades: PairTrade[];
}
export interface PairCoin {
  mint: string;
  symbol: string | null;
  name: string | null;
  image: string | null;
  launchedAt: string | null;
  a: PairSide;
  b: PairSide;
  leadSec: number;
  exitLeadSec: number | null;
}
export interface PairRead {
  a: string;
  b: string;
  windowSec: number;
  coins: PairCoin[];
  summary: {
    coins: number;
    of: number;
    medianGapSec: number | null;
    aFirst: number;
    bFirst: number;
    sizeRatio: number | null;
    solInA: number;
    solInB: number;
    netA: number;
    netB: number;
    bothUp: number;
    bothSold: number;
    medianExitGapSec: number | null;
  };
}

export interface Label {
  wallet: string;
  name: string;
  category: "kol" | "tracked";
}

export interface MapSummary {
  id: string;
  title: string;
  nodes: number;
  shareSlug: string | null;
  sharedAt: string | null;
  updatedAt: string;
}

export interface MapDoc {
  v: 1;
  nodes: AsylGraph["nodes"];
  edges: AsylGraph["edges"];
  positions: Record<string, [number, number]>;
  notes: Record<string, string>;
  note: string;
  /** Link kinds switched off. */
  hidden: string[];
  /** Kinds of link off for one wallet only, by wallet. */
  walletHidden?: Record<string, string[]>;
  /** Bubbles no drawn link reaches leave the map. */
  hideLoose?: boolean;
  /** Nodes taken off the map, kept so they can be brought back. */
  removed?: string[];
  /** Links hidden one by one, by edgeKey. */
  cut?: string[];
  /** The amount sliders. */
  cutoffs?: Cutoffs;
  /** The reader's own lines, text boxes and pen strokes (none in maps saved before the pen). */
  drawings?: Partial<Drawings>;
  /** Bubbles the user placed by hand, which the layout leaves where they are. */
  pinned?: string[];
  /** Grid mode; a map saved before it had none and opens without it. */
  grid?: boolean;
  /** Analyst Mode: the map drawn as a flowchart. */
  analyst?: boolean;
  /** Which kinds of line carry their time. */
  times?: TimeLabels;
  focus: string | null;
}

/** The wallet modal's read, as much of it as Asyl's panel shows. */
export interface Dossier {
  wallet: string;
  labels: { text: string; tone: string; source: string; detail?: string }[];
  kol: {
    name: string | null;
    twitter: string | null;
    knownSideOf: { wallet: string; name: string | null } | null;
  } | null;
  tracked?: { name: string; category: "kol" | "tracked" } | null;
  live: {
    readAt: string;
    balanceSol: number | null;
    txCount: number;
    complete: boolean;
    lastAt: string | null;
  } | null;
  firstSeenAt: string | null;
  firstSeenIsFloor: boolean;
  funder: {
    status: string;
    wallet: string | null;
    amountSol: number | null;
    fundedAt: string | null;
    label: string | null;
  } | null;
  risk: {
    score: number;
    coins: number;
    dumps: number;
    fastExits: number;
    snipes: number;
    wins: number;
    earlyWins: number;
    winScore: number;
    pnl: { coins: number; medianSol: number | null; medianPct: number | null } | null;
  } | null;
  totals: { coins: number; wins: number; solIn: number; solOut: number; netSol: number; profitable: number };
}

/** A coin's bundle and sniper check and its dev's history (the API's asyl/report.ts). */
export interface CoinReport {
  mint: string;
  launch: {
    buyers: {
      wallet: string;
      rank: number;
      sniper: boolean;
      solIn: number;
      solOut: number;
      boughtPct: number | null;
      heldPct: number | null;
      sold: boolean;
      funder: string | null;
    }[];
    snipers: number;
    boughtPct: number;
    heldPct: number;
    soldCount: number;
    groups: { funder: string; wallets: string[]; heldPct: number }[];
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
  verdict: { level: "high" | "some" | "low" | "unknown"; text: string };
  waves: { from: string; to: string; wallets: string[]; sol: number }[];
  concentration: {
    at: string;
    top10: number | null;
    largest: number | null;
    bundled: number | null;
    holders: number | null;
  }[];
  flow: {
    group: "dev" | "sniper" | "early" | "top" | "rest";
    wallets: number;
    solIn: number;
    solOut: number;
  }[];
  dev: {
    wallet: string;
    risk: number | null;
    launch: {
      score: number;
      launches: number;
      inBand: number;
      graded: number;
      wins: number;
      stops: number;
    } | null;
    family: { creators: number; score: number; launches: number; wins: number; stops: number } | null;
    coins: {
      mint: string;
      symbol: string | null;
      at: string;
      outcome: "win" | "stop" | "fizzle" | null;
      peakPct: number | null;
    }[];
    thisCoin: { solIn: number; solOut: number; sold: boolean; firstSellAt: string | null } | null;
  } | null;
}

/** A watched wallet and what it did lately (the API's asyl/watch.ts). */
export interface WatchRow {
  wallet: string;
  name: string | null;
  seenAt: string;
  events: {
    kind: "funded" | "bought" | "deployed";
    target: string;
    symbol: string | null;
    sol: number | null;
    at: string;
  }[];
  fresh: number;
}

const enc = encodeURIComponent;

/** What a holder read keeps: the least share held now, the least SOL put in, and every one of them. */
export interface HolderQuery {
  minPct?: number;
  minSol?: number;
  all?: boolean;
}
const holderQuery = (q?: HolderQuery) => {
  const p = new URLSearchParams();
  if (q?.minPct) p.set("minPct", String(q.minPct));
  if (q?.minSol !== undefined) p.set("minSol", String(q.minSol));
  if (q?.all) p.set("all", "1");
  const s = p.toString();
  return s ? `?${s}` : "";
};

export const asylApi = {
  me: () => api<AsylMe>("/asyl/me"),
  resolve: (address: string) =>
    api<{ kind: "wallet" | "token"; known: boolean; name?: string | null }>(`/asyl/resolve/${enc(address)}`),
  wallet: (wallet: string) => api<GraphRead & { coTradersTotal?: number }>(`/asyl/wallet/${enc(wallet)}`),
  dossier: (wallet: string) => api<Dossier>(`/asyl/wallet/${enc(wallet)}/dossier`),
  search: (q: string) => api<SearchRead>(`/asyl/search?q=${encodeURIComponent(q)}`),
  pair: (a: string, b: string) => api<PairRead>(`/asyl/pair/${enc(a)}/${enc(b)}`),
  similar: (wallet: string, all = false) =>
    api<SimilarRead>(`/asyl/wallet/${enc(wallet)}/similar${all ? "?all=1" : ""}`),
  token: (mint: string, q?: HolderQuery) =>
    api<GraphRead & { readAt: string | null }>(`/asyl/token/${enc(mint)}${holderQuery(q)}`),
  report: (mint: string) => api<CoinReport>(`/asyl/token/${enc(mint)}/report`),
  earlyBuyers: (mint: string) => api<GraphRead & { shown: number }>(`/asyl/token/${enc(mint)}/early`),
  topTraders: (mint: string) =>
    api<GraphRead & { shown: number; total: number | null; note: string }>(
      `/asyl/token/${enc(mint)}/top-traders`,
    ),
  launches: (wallet: string) => api<GraphRead & { shown: number }>(`/asyl/wallet/${enc(wallet)}/launches`),
  pastHolders: (mint: string, q?: HolderQuery) =>
    api<GraphRead & { total: number; shown: number; note: string }>(
      `/asyl/token/${enc(mint)}/past-holders${holderQuery(q)}`,
    ),
  deployer: (mint: string) =>
    post<
      GraphRead & {
        deployer: { wallet: string; verified: boolean } | null;
        credits?: number;
        cached?: boolean;
        allowance?: Allowance;
      }
    >(`/asyl/deployer/${enc(mint)}`),
  links: (wallets: string[], tokens: string[], deployers = false) =>
    post<GraphRead>("/asyl/links", { wallets, tokens, deployers }),
  labels: () => api<{ pro: boolean; cap: number; nameMax: number; wallets: Label[] }>("/asyl/labels"),
  labelsMap: () => api<GraphRead>("/asyl/labels/map"),
  saveLabel: (wallet: string, name: string, kol: boolean) =>
    put<{ wallet: Label }>(`/asyl/labels/${enc(wallet)}`, { name, kol }),
  removeLabel: (wallet: string) => del<{ removed: boolean }>(`/asyl/labels/${enc(wallet)}`),
  flows: (wallet: string) => post<ChainRead>(`/asyl/chain/flows/${enc(wallet)}`),
  funders: (wallets: string[]) =>
    post<
      ChainRead & {
        found: number;
        results?: Record<string, "found" | "none" | "empty" | "busy" | "failed">;
      }
    >("/asyl/chain/funders", { wallets }),
  chainToken: (mint: string, q?: HolderQuery) =>
    post<ChainRead>(`/asyl/chain/token/${enc(mint)}${holderQuery(q)}`),
  trace: (wallet: string) =>
    post<ChainRead & { trace: { path: string[]; stop: string; asked: number }; note: string }>(
      `/asyl/chain/trace/${enc(wallet)}`,
    ),
  exits: (wallet: string) =>
    post<
      ChainRead & {
        exits: {
          path: string[];
          stop: string;
          asked: number;
          hops: { from: string; to: string; sol: number }[];
        };
        note: string;
      }
    >(`/asyl/chain/exits/${enc(wallet)}`),
  deposits: (wallet: string) =>
    post<
      GraphRead & {
        deposits: { checked: number; deposits: DepositAddress[]; stop: string };
        note: string;
        burn: BurnSpend;
      }
    >(`/asyl/chain/deposits/${enc(wallet)}`),
  bridges: (wallet: string) =>
    post<GraphRead & { bridges: BridgeMove[]; note: string; burn: BurnSpend }>(
      `/asyl/chain/bridges/${enc(wallet)}`,
    ),
  commonFunder: (wallets: string[]) =>
    post<
      GraphRead & {
        best: { funder: string; wallets: { wallet: string; hops: number }[] } | null;
        note: string;
      }
    >("/asyl/common-funder", { wallets }),
  watches: () => api<{ cap: number; wallets: WatchRow[] }>("/asyl/watch"),
  watch: (wallet: string, name: string | null) => put<{ ok: true }>(`/asyl/watch/${enc(wallet)}`, { name }),
  unwatch: (wallet: string) => del<{ removed: boolean }>(`/asyl/watch/${enc(wallet)}`),
  watchSeen: (wallet: string | null) => post<{ ok: true }>("/asyl/watch/seen", { wallet }),
  maps: () => api<{ maps: MapSummary[]; cap: number }>("/asyl/maps"),
  map: (id: string) => api<MapSummary & { doc: MapDoc }>(`/asyl/maps/${enc(id)}`),
  createMap: (title: string, doc: MapDoc) => post<{ map: MapSummary }>("/asyl/maps", { title, doc }),
  updateMap: (id: string, title: string, doc: MapDoc) =>
    put<{ ok: true }>(`/asyl/maps/${enc(id)}`, { title, doc }),
  deleteMap: (id: string) => del<{ removed: boolean }>(`/asyl/maps/${enc(id)}`),
  share: (id: string) => post<{ slug: string }>(`/asyl/maps/${enc(id)}/share`),
  unshare: (id: string) => del<{ unshared: boolean }>(`/asyl/maps/${enc(id)}/share`),
  shared: (slug: string) =>
    api<{ title: string; sharedAt: string | null; doc: MapDoc }>(`/asyl/shared/${enc(slug)}`),
  /** Admin only: the link stops answering, and its owner can't share the map again. */
  takeDown: (slug: string) => post<{ takenDown: boolean }>(`/asyl/admin/shared/${enc(slug)}/takedown`),
};

/** A KOL's X picture path on the API, as an absolute URL. */
export const avatarUrl = (path: string) => `${API_URL}${path}`;
