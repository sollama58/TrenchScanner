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
  chain: Allowance | null;
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

const enc = encodeURIComponent;

export const asylApi = {
  me: () => api<AsylMe>("/asyl/me"),
  resolve: (address: string) =>
    api<{ kind: "wallet" | "token"; known: boolean; name?: string | null }>(`/asyl/resolve/${enc(address)}`),
  wallet: (wallet: string) => api<GraphRead & { coTradersTotal?: number }>(`/asyl/wallet/${enc(wallet)}`),
  dossier: (wallet: string) => api<Dossier>(`/asyl/wallet/${enc(wallet)}/dossier`),
  similar: (wallet: string, all = false) =>
    api<SimilarRead>(`/asyl/wallet/${enc(wallet)}/similar${all ? "?all=1" : ""}`),
  token: (mint: string) => api<GraphRead & { readAt: string | null }>(`/asyl/token/${enc(mint)}`),
  pastHolders: (mint: string) =>
    api<GraphRead & { total: number; shown: number; note: string }>(`/asyl/token/${enc(mint)}/past-holders`),
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
  chainToken: (mint: string) => post<ChainRead>(`/asyl/chain/token/${enc(mint)}`),
  trace: (wallet: string) =>
    post<ChainRead & { trace: { path: string[]; stop: string; asked: number }; note: string }>(
      `/asyl/chain/trace/${enc(wallet)}`,
    ),
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
};

/** A KOL's X picture path on the API, as an absolute URL. */
export const avatarUrl = (path: string) => `${API_URL}${path}`;
