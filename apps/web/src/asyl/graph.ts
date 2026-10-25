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
  /** When the market cap was read. */
  mcapAt?: string | null;
  athUsd?: number | null;
  launchedAt?: string | null;
  /** Coins: the wallet that deployed it, when TrenchScanner knows it. */
  deployer?: string | null;
  /** Whether `deployer` was read off the create transaction, or is a creator a takeover can move. */
  deployerVerified?: boolean | null;
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
  /** SOL paid, moved or traded, when the link is money. */
  sol?: number | null;
  /** Coins moved, for a coin transfer read from the chain. */
  tokens?: number | null;
  /** % of the coin's supply held or moved. */
  pct?: number | null;
  /** A "bought together" link: coins both bought within minutes, of the coins read, and the median seconds apart. */
  shared?: number | null;
  of?: number | null;
  gapSec?: number | null;
  /** ...and who usually bought first: median seconds from `a`'s first buy to `b`'s, negative when `b` led. */
  leadSec?: number | null;
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
      // A deployer read off the create transaction is never replaced by an unconfirmed one.
      if ((k === "deployer" || k === "deployerVerified") && have.deployerVerified && !n.deployerVerified)
        continue;
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
  // A confirmed deployer replaces any other wallet drawn as the coin's deployer (a takeover's).
  const confirmed = new Map(
    g.nodes
      .filter((n) => n.kind === "token" && n.deployer && n.deployerVerified)
      .map((n) => [n.id, n.deployer]),
  );
  const stale = g.edges.some((e) => e.kind === "created" && confirmed.has(e.b) && confirmed.get(e.b) !== e.a);
  if (stale)
    g = {
      ...g,
      edges: g.edges.filter(
        (e) => !(e.kind === "created" && confirmed.has(e.b) && confirmed.get(e.b) !== e.a),
      ),
    };
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
  filter: LinkFilter = {},
): AsylGraph {
  const per = filter.perWallet;
  const edges = g.edges.filter(
    (e) =>
      !hidden.has(e.kind) &&
      !filter.cut?.has(edgeKey(e)) &&
      !offFor(per?.get(e.a), e, true) &&
      !offFor(per?.get(e.b), e, false) &&
      (!filter.cutoffs || clearsCutoffs(e, filter.cutoffs, filter.solUsd ?? null)),
  );
  // Every bubble stays unless the reader took it off (user report 2026-10-25: bubbles vanished as
  // link kinds were switched), or asked for the ones no drawn link reaches to go.
  if (!filter.hideLoose) return { nodes: g.nodes, edges };
  const touched = new Set(edges.flatMap((e) => [e.a, e.b]));
  return { nodes: g.nodes.filter((n) => touched.has(n.id) || keep.has(n.id)), edges };
}

/**
 * The amount sliders (user ask 2026-10-24): the least SOL, USD, coins or % of supply a money link
 * (funding, a transfer, a trade) must carry to be drawn. 0 draws them all.
 */
export interface Cutoffs {
  sol: number;
  usd: number;
  tokens: number;
  pct: number;
  /** "Bought together" links (user ask 2026-10-25): the fewest coins in common, 0 for any. */
  shared: number;
  /** ...and the most median seconds between their first buys, 0 for any. */
  gap: number;
  /**
   * ...and who usually buys first: 0 either, 1 the co-trader (the line's far end), 2 the wallet it
   * was found from (the line's near end).
   */
  first: number;
}

export const NO_CUTOFFS: Cutoffs = { sol: 0, usd: 0, tokens: 0, pct: 0, shared: 0, gap: 0, first: 0 };

/** Cutoffs as read back from storage or a saved map: anything missing or odd draws everything. */
export function cleanCutoffs(raw: unknown): Cutoffs {
  if (!raw || typeof raw !== "object") return NO_CUTOFFS;
  const r = raw as Partial<Record<keyof Cutoffs, unknown>>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  return {
    sol: n(r.sol),
    usd: n(r.usd),
    tokens: n(r.tokens),
    pct: n(r.pct),
    shared: n(r.shared),
    gap: n(r.gap),
    first: r.first === 1 || r.first === 2 ? r.first : 0,
  };
}

/** What else keeps a link off the map: links hidden one by one (by edgeKey), and the sliders. */
export interface LinkFilter {
  cut?: ReadonlySet<string>;
  cutoffs?: Cutoffs;
  /** SOL's price, for the USD slider; without one the USD slider cuts nothing. */
  solUsd?: number | null;
  /** Kinds of link switched off for one wallet only (user ask 2026-10-25), by wallet. */
  perWallet?: ReadonlyMap<string, ReadonlySet<WalletSwitch>>;
  /** Take off bubbles no drawn link reaches (the selection and focus stay). Off: every bubble stays. */
  hideLoose?: boolean;
}

/**
 * What one wallet's own switches can turn off: a kind of link, or its transfers one way only
 * (user ask 2026-10-25: show and filter by transfer direction).
 */
export type WalletSwitch = AsylEdgeKind | "transfer:out" | "transfer:in";
export const WALLET_SWITCHES: readonly WalletSwitch[] = [...EDGE_KINDS, "transfer:out", "transfer:in"];
export const SWITCH_LABEL: Record<WalletSwitch, string> = {
  ...EDGE_LABEL,
  "transfer:out": "Sent",
  "transfer:in": "Received",
};

/** Whether a wallet's switches hide this link; `near` when the wallet is the link's sending end. */
function offFor(off: ReadonlySet<WalletSwitch> | undefined, e: AsylEdge, near: boolean): boolean {
  if (!off) return false;
  if (off.has(e.kind)) return true;
  return e.kind === "transfer" && off.has(near ? "transfer:out" : "transfer:in");
}

/** Per-wallet switches as saved ({wallet: kinds}), read back as the filter takes them. */
export function perWalletOf(raw: Record<string, readonly string[]> | null | undefined) {
  const m = new Map<string, Set<WalletSwitch>>();
  for (const [w, kinds] of Object.entries(raw ?? {})) {
    const set = new Set(WALLET_SWITCHES.filter((k) => kinds.includes(k)));
    if (set.size) m.set(w, set);
  }
  return m;
}

/** The link kinds that carry money, which the sliders cut. */
export const MONEY_KINDS: readonly AsylEdgeKind[] = ["funded", "transfer", "traded"];

/** A money link's SOL: its own, or, on maps saved before links carried it, its weight. */
export function edgeSol(e: AsylEdge): number | null {
  if (e.sol !== undefined && e.sol !== null) return e.sol;
  if (e.kind === "funded" || e.kind === "traded") return e.weight;
  return null;
}

/**
 * Whether a link clears the sliders. A "bought together" link is held to its own two; any other
 * link that isn't money, or carries no amount, always clears them.
 */
export function clearsCutoffs(e: AsylEdge, c: Cutoffs, solUsd: number | null): boolean {
  if (e.kind === "cotrade") {
    // Coins in common: its own count, or, on maps saved before links carried it, its weight.
    if (c.shared > 0 && (e.shared ?? e.weight) < c.shared) return false;
    if (c.gap > 0 && e.gapSec !== undefined && e.gapSec !== null && e.gapSec > c.gap) return false;
    if (c.first > 0 && e.leadSec !== undefined && e.leadSec !== null) {
      if (c.first === 1 && e.leadSec >= 0) return false;
      if (c.first === 2 && e.leadSec <= 0) return false;
    }
    return true;
  }
  if (!MONEY_KINDS.includes(e.kind)) return true;
  const s = edgeSol(e);
  if (s !== null) {
    if (s < c.sol) return false;
    if (solUsd && s * solUsd < c.usd) return false;
  }
  if (e.tokens !== undefined && e.tokens !== null && e.tokens < c.tokens) return false;
  if (e.pct !== undefined && e.pct !== null && e.pct < c.pct) return false;
  return true;
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

const pad2 = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * When a link happened (a funding, a transfer, a deploy), written to fit along its line (user ask
 * 2026-10-24): the longest of
 * "12 Oct 2025 14:05", "12 Oct 14:05", "14:05" (funded today) or "12 Oct" that fits `room`
 * characters, in the reader's own time. The year shows only when it isn't this year. Null when
 * none fits, or the time isn't known.
 */
export function edgeTimeLabel(iso: string | null | undefined, room: number, now = new Date()): string | null {
  if (!iso) return null;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  const day = `${t.getDate()} ${MONTHS[t.getMonth()]}`;
  const time = `${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
  const today = t.toDateString() === now.toDateString();
  const options = [
    t.getFullYear() !== now.getFullYear() ? `${day} ${t.getFullYear()} ${time}` : null,
    `${day} ${time}`,
    today ? time : day,
  ].filter((s): s is string => s !== null);
  return options.find((s) => s.length <= room) ?? null;
}

/** The link kinds whose lines can carry their time, and whether each does unless switched. */
export type TimedKind = "funded" | "transfer" | "created";
export const TIMED_KINDS: readonly TimedKind[] = ["funded", "created", "transfer"];
export type TimeLabels = Record<TimedKind, boolean>;
export const DEFAULT_TIME_LABELS: TimeLabels = { funded: true, created: true, transfer: false };

/** The full time, for a line's hover. */
export function edgeTimeFull(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  return `${t.getDate()} ${MONTHS[t.getMonth()]} ${t.getFullYear()}, ${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
}

/**
 * What the reader draws on a map (user ask 2026-10-24): their own lines between two bubbles, each
 * with a label, and free text boxes. They are the reader's, not a read: kept with the map, drawn
 * over it, and in its share image.
 */
export const DRAW_COLOURS = ["#fff3e6", "#ff7a2f", "#ffd34d", "#ff5a4a", "#6ee7f9"] as const;
/** A drawing's colour: one of the swatches, or any the reader picks (#rrggbb, lower case). */
export type DrawColour = string;

export interface DrawnLine {
  id: string;
  a: string;
  b: string;
  label: string;
  colour: DrawColour;
}

export interface DrawnText {
  id: string;
  /** Where its top-left corner sits, in the map's own units (as bubbles are placed). */
  x: number;
  y: number;
  text: string;
  colour: DrawColour;
}

/** A freehand pen stroke (user ask 2026-10-25), in the map's own units, as bubbles are placed. */
export interface DrawnStroke {
  id: string;
  points: [number, number][];
  colour: DrawColour;
  /** Its thickness in map units, so it zooms with the map as ink on the wall would. */
  width: number;
}

export interface Drawings {
  lines: DrawnLine[];
  texts: DrawnText[];
  strokes: DrawnStroke[];
}

export const NO_DRAWINGS: Drawings = { lines: [], texts: [], strokes: [] };
/** Strokes a map keeps, and points per stroke: room for a lot of scribbling within a save. */
export const STROKES_MAX = 200;
export const STROKE_POINTS_MAX = 500;
/** The pen's thicknesses, in screen pixels at the zoom it draws at. */
export const PEN_WIDTHS = [2, 4, 8, 14] as const;

/** Drawings as saved, whatever their age: maps saved before the pen have no strokes. */
export function cleanDrawings(d: Partial<Drawings> | null | undefined): Drawings {
  return { lines: d?.lines ?? [], texts: d?.texts ?? [], strokes: d?.strokes ?? [] };
}

/** A smooth path through a stroke's points: curves between their midpoints. A dot for one point. */
export function strokePath(points: readonly (readonly [number, number])[]): string {
  const f = (n: number) => Math.round(n * 10) / 10;
  if (points.length === 0) return "";
  const [x0, y0] = points[0]!;
  if (points.length === 1) return `M${f(x0)} ${f(y0)} l0.01 0`;
  let d = `M${f(x0)} ${f(y0)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i]!;
    const [nx, ny] = points[i + 1]!;
    d += ` Q${f(x)} ${f(y)} ${f((x + nx) / 2)} ${f((y + ny) / 2)}`;
  }
  const [xl, yl] = points[points.length - 1]!;
  return d + ` L${f(xl)} ${f(yl)}`;
}

/** Fewer points, within `tolerance` of the line they drew: a long stroke fits what a map keeps. */
export function thinStroke(points: [number, number][], max = STROKE_POINTS_MAX): [number, number][] {
  let out = points;
  for (let tol = 0.5; out.length > max && tol < 1e6; tol *= 2) out = simplify(points, tol);
  return out.length > max ? out.filter((_, i) => i % Math.ceil(out.length / max) === 0) : out;
}

function simplify(pts: [number, number][], tol: number): [number, number][] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a]!;
    const [bx, by] = pts[b]!;
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let far = -1;
    let most = tol;
    for (let i = a + 1; i < b; i++) {
      const [x, y] = pts[i]!;
      const d = Math.abs((bx - ax) * (ay - y) - (ax - x) * (by - ay)) / len;
      if (d > most) {
        most = d;
        far = i;
      }
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push([a, far], [far, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}
export const DRAWN_LABEL_MAX = 80;
export const DRAWN_TEXT_MAX = 400;

/** A text box's size in map units: 14-unit type, 20-unit lines, 12 units of padding. */
export function textBoxSize(text: string): { w: number; h: number } {
  const lines = (text || " ").split("\n");
  const longest = Math.max(...lines.map((l) => l.length), 4);
  return { w: Math.min(320, longest * 7.6) + 24, h: lines.length * 20 + 16 };
}

export const newDrawingId = () => Math.random().toString(36).slice(2, 10);
