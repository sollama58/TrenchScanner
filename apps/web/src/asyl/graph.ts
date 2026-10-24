/**
 * Asyl's map model (asyl.trenchscanner.app, user ask 2026-10-24): the same nodes and edges the API
 * answers with (apps/api/src/asyl/types.ts), merged answer by answer into the one map on screen.
 */

export type AsylNodeKind = "wallet" | "token";
export type AsylTag =
  | "mine"
  | "kol"
  | "kol-side"
  | "exchange"
  | "dev"
  | "dumper"
  | "winner"
  | "sniper"
  | "risky"
  | "bot"
  | "farm";

export interface AsylNode {
  id: string;
  kind: AsylNodeKind;
  name: string | null;
  tags: AsylTag[];
  risk?: number | null;
  win?: number | null;
  coins?: number | null;
  medianPnlSol?: number | null;
  avatar?: string | null;
  title?: string | null;
  image?: string | null;
  mcapUsd?: number | null;
  athUsd?: number | null;
  launchedAt?: string | null;
  /** Coins: the wallet that deployed it, when TrenchScanner knows it. */
  deployer?: string | null;
}

export type AsylEdgeKind = "funded" | "transfer" | "cotrade" | "side" | "created" | "holds" | "traded";

export interface AsylEdge {
  a: string;
  b: string;
  kind: AsylEdgeKind;
  weight: number;
  label: string;
  source: "stored" | "chain";
  mint?: string | null;
  at?: string | null;
}

export interface AsylGraph {
  nodes: AsylNode[];
  edges: AsylEdge[];
}

export const EDGE_KINDS: readonly AsylEdgeKind[] = [
  "funded",
  "transfer",
  "side",
  "cotrade",
  "created",
  "traded",
  "holds",
];

export const EDGE_LABEL: Record<AsylEdgeKind, string> = {
  funded: "Funded",
  transfer: "Transfers",
  side: "Side wallets",
  cotrade: "Bought together",
  created: "Deployed",
  traded: "Traded",
  holds: "Holds",
};

/** Directed kinds draw an arrow from `a` to `b`. */
export const DIRECTED: ReadonlySet<AsylEdgeKind> = new Set(["funded", "transfer", "side", "created"]);

export const TAG_LABEL: Record<AsylTag, string> = {
  mine: "Your label",
  kol: "KOL",
  "kol-side": "KOL side",
  exchange: "Exchange",
  dev: "Deployer",
  dumper: "Dumper",
  winner: "Winner",
  sniper: "Sniper",
  risky: "Risky",
  bot: "Bot",
  farm: "Dev farm",
};

export const edgeKey = (e: Pick<AsylEdge, "kind" | "a" | "b" | "mint">) =>
  `${e.kind}|${e.a}|${e.b}|${e.mint ?? ""}`;

/**
 * `next` merged into `base`: new nodes and edges added, a node's empty fields filled (a name the
 * newer answer has, the reader's own label above all), an edge's reading replaced by a stronger one.
 */
export function mergeGraph(base: AsylGraph, next: AsylGraph): AsylGraph {
  const nodes = new Map(base.nodes.map((n) => [n.id, n]));
  for (const n of next.nodes) {
    const have = nodes.get(n.id);
    if (!have) {
      nodes.set(n.id, n);
      continue;
    }
    const merged: AsylNode = { ...have };
    for (const [k, v] of Object.entries(n) as [keyof AsylNode, unknown][]) {
      if (v === undefined || v === null) continue;
      if (k === "tags") continue;
      // The newer name wins when it is the reader's own label; otherwise the first one stays.
      if (k === "name" && have.name && !n.tags.includes("mine")) continue;
      (merged as unknown as Record<string, unknown>)[k] = v;
    }
    merged.tags = [...new Set([...have.tags, ...n.tags])];
    if (n.tags.includes("mine")) merged.name = n.name;
    nodes.set(n.id, merged);
  }
  const edges = new Map(base.edges.map((e) => [edgeKey(e), e]));
  for (const e of next.edges) {
    const have = edges.get(edgeKey(e));
    if (!have || e.weight >= have.weight || (e.source === "chain" && have.source === "stored"))
      edges.set(edgeKey(e), e);
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

/**
 * The map with a "Deployed" line from each coin's deployer to the coin wherever both are on it,
 * whichever read brought each one (user ask 2026-10-24: deployer markers and lines).
 */
export function withDeployLines(g: AsylGraph): AsylGraph {
  const wallets = new Set(g.nodes.filter((n) => n.kind === "wallet").map((n) => n.id));
  const have = new Set(g.edges.filter((e) => e.kind === "created").map((e) => `${e.a}|${e.b}`));
  const lines: AsylEdge[] = [];
  for (const n of g.nodes) {
    if (n.kind !== "token" || !n.deployer || !wallets.has(n.deployer)) continue;
    if (have.has(`${n.deployer}|${n.id}`)) continue;
    lines.push({
      a: n.deployer,
      b: n.id,
      kind: "created",
      weight: 1,
      label: "Deployed it",
      source: "stored",
      mint: n.id,
      at: n.launchedAt ?? null,
    });
  }
  if (lines.length === 0) return g;
  // Whoever deployed a coin on the map is marked as a deployer.
  const devs = new Set(lines.map((e) => e.a));
  return {
    nodes: g.nodes.map((n) =>
      devs.has(n.id) && !n.tags.includes("dev") ? { ...n, tags: [...n.tags, "dev" as const] } : n,
    ),
    edges: [...g.edges, ...lines],
  };
}

/** The map without `ids`, and without edges left hanging. */
export function removeNodes(g: AsylGraph, ids: ReadonlySet<string>): AsylGraph {
  return {
    nodes: g.nodes.filter((n) => !ids.has(n.id)),
    edges: g.edges.filter((e) => !ids.has(e.a) && !ids.has(e.b)),
  };
}

/** Nodes with no edge among the shown kinds, other than `keep`, are dropped from view. */
export function visibleGraph(
  g: AsylGraph,
  hidden: ReadonlySet<AsylEdgeKind>,
  keep: ReadonlySet<string>,
): AsylGraph {
  const edges = g.edges.filter((e) => !hidden.has(e.kind));
  const touched = new Set(edges.flatMap((e) => [e.a, e.b]));
  return { nodes: g.nodes.filter((n) => touched.has(n.id) || keep.has(n.id)), edges };
}

/** Each node's neighbours, by edge. */
export function neighbours(g: AsylGraph, id: string): { node: string; edge: AsylEdge }[] {
  const out: { node: string; edge: AsylEdge }[] = [];
  for (const e of g.edges) {
    if (e.a === id) out.push({ node: e.b, edge: e });
    else if (e.b === id) out.push({ node: e.a, edge: e });
  }
  return out;
}

/**
 * Clusters for the map's tint: wallets tied by funding, transfers or sides fall in one group
 * (union-find), so a bundle reads as one colour. Coins and exchange wallets don't join groups.
 * Groups of one get no colour (-1).
 */
export function clusterOf(g: AsylGraph): Map<string, number> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let p = parent.get(x) ?? x;
    while (p !== (parent.get(p) ?? p)) p = parent.get(p) ?? p;
    parent.set(x, p);
    return p;
  };
  const kindOf = new Map(g.nodes.map((n) => [n.id, n]));
  const joins = (id: string) => {
    const n = kindOf.get(id);
    return !!n && n.kind === "wallet" && !n.tags.includes("exchange");
  };
  for (const e of g.edges) {
    if (e.kind !== "funded" && e.kind !== "transfer" && e.kind !== "side") continue;
    if (!joins(e.a) || !joins(e.b)) continue;
    const ra = find(e.a);
    const rb = find(e.b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const size = new Map<string, number>();
  for (const n of g.nodes) if (joins(n.id)) size.set(find(n.id), (size.get(find(n.id)) ?? 0) + 1);
  const ids = new Map<string, number>();
  const out = new Map<string, number>();
  const ordered = [...size.entries()].filter(([, s]) => s > 1).sort((a, b) => b[1] - a[1]);
  ordered.forEach(([root], i) => ids.set(root, i));
  for (const n of g.nodes) out.set(n.id, joins(n.id) ? (ids.get(find(n.id)) ?? -1) : -1);
  return out;
}

export const shortAddr = (a: string) => (a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);

export function nodeName(n: AsylNode): string {
  return n.name ?? shortAddr(n.id);
}

/** Edges as CSV: one row per link, for a spreadsheet. */
export function graphCsv(g: AsylGraph): string {
  const names = new Map(g.nodes.map((n) => [n.id, n.name ?? ""]));
  const cell = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [["from", "from_name", "to", "to_name", "link", "detail", "weight", "coin", "when", "source"]];
  for (const e of g.edges)
    rows.push([
      e.a,
      names.get(e.a) ?? "",
      e.b,
      names.get(e.b) ?? "",
      e.kind,
      e.label,
      String(e.weight),
      e.mint ?? "",
      e.at ?? "",
      e.source,
    ]);
  return rows.map((r) => r.map(cell).join(",")).join("\n") + "\n";
}

const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The first Solana address in pasted text: a bare address, or one inside a Solscan, DexScreener or pump.fun link. */
export function addressIn(text: string): string | null {
  const t = text.trim();
  if (ADDRESS_RE.test(t)) return t;
  for (const part of t.split(/[\s/?#=&]+/)) if (ADDRESS_RE.test(part)) return part;
  return null;
}
