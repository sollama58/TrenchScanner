/**
 * A wallet's web (user ask 2026-10-16): the types GET /utilities/side-web/:wallet answers with, and
 * the map's layout. The hub sits in the middle; each kind of labeled wallet takes its own arc
 * round it (Known Sides nearest, then funded wallets, then Possible Sides by how much they shared),
 * spilling onto further rings when an arc is full; shared funders sit outside the wallets they paid.
 * Pure, so it is tested on its own.
 */

/** Mirrors apps/api/src/sideWeb.ts. */
export type WebRole = "hub" | "known" | "funded" | "possible" | "bundle" | "funder";
export type WebTie = "known" | "funded" | "trades" | "transfers";

export interface WebNode {
  wallet: string;
  role: WebRole;
  name: string | null;
  pct: number;
  hours: number;
  transfers?: number;
  funds?: number;
}

export interface WebEdge {
  from: string;
  to: string;
  type: WebTie;
  pct?: number;
  hours?: number;
  count?: number;
  sol?: number | null;
  at?: string | null;
}

export interface SideWeb {
  wallet: string;
  hub: string;
  kol: boolean;
  name: string | null;
  total: number;
  counts: { known: number; funded: number; possible: number; bundle: number; transfers: number };
  nodes: WebNode[];
  edges: WebEdge[];
  truncated: boolean;
}

export const WEB_TIES: readonly WebTie[] = ["known", "funded", "trades", "transfers"];

/** Each tie in words, as the legend names it. */
export const TIE_LABEL: Record<WebTie, string> = {
  known: "Known Side",
  funded: "Funded",
  trades: "Bought together",
  transfers: "Transfers",
};

export interface PlacedNode extends WebNode {
  x: number;
  y: number;
  r: number;
  /** Labeled by transfers alone: drawn in the transfers' violet. */
  moverOnly: boolean;
}

export interface PlacedEdge extends WebEdge {
  /** The path, a quadratic curve. */
  d: string;
  /** Its middle and heading there, for a funding arrow. */
  mid: { x: number; y: number; angle: number };
  width: number;
}

export interface WebLayout {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  box: { x: number; y: number; w: number; h: number };
}

const HUB_R = 32;
const GAP = 7;
/** The least room between two bubbles' edges once pushed apart: enough for a name between them. */
const LABEL_GAP = 18;

/** A bubble's size: the hub largest, then Known Sides, funded wallets, and Possible Sides by % shared. */
export function webRadius(n: Pick<WebNode, "role" | "pct">): number {
  switch (n.role) {
    case "hub":
      return HUB_R;
    case "known":
      return 19;
    case "funded":
      return 16;
    case "funder":
      return 9;
    default:
      return n.pct > 0 ? 10 + Math.min(100, n.pct) * 0.07 : 12;
  }
}

/** The arcs' order round the hub, clockwise from the top. */
const ARC_ORDER: readonly WebRole[] = ["known", "funded", "possible", "bundle"];
/** How far each kind's first ring sits from the hub's centre. */
const RING: Record<string, number> = { known: 96, funded: 136, possible: 168, bundle: 150 };
const RING_STEP = 40;

/** A tie's line weight. */
export function tieWidth(e: Pick<WebEdge, "type" | "pct" | "count">): number {
  switch (e.type) {
    case "known":
      return 3;
    case "funded":
      return 2;
    case "trades":
      return 1 + (Math.min(100, e.pct ?? 0) / 100) * 1.8;
    default:
      return Math.min(4.5, 1.4 + Math.log2(1 + (e.count ?? 1)) * 0.7);
  }
}

/** The labeled wallets' places on their arcs, before collisions are pushed apart. */
function arcPlaces(nodes: readonly WebNode[]): Map<string, { x: number; y: number }> {
  const groups = ARC_ORDER.map((role) =>
    nodes
      .filter((n) => n.role === role)
      // In the order the API sends: Possible Sides re-sorted by % shared below.
      .map((n, i) => ({ n, i })),
  ).filter((g) => g.length > 0);
  const out = new Map<string, { x: number; y: number }>();
  const total = groups.reduce((s, g) => s + g.length, 0);
  if (total === 0) return out;
  // Each arc's share of the circle follows its size, with a floor so a lone Known Side still gets room.
  const weights = groups.map((g) => Math.max(g.length, total * 0.12));
  const sum = weights.reduce((a, b) => a + b, 0);
  let start = -Math.PI / 2;
  groups.forEach((g, gi) => {
    const span = (weights[gi]! / sum) * Math.PI * 2;
    const role = g[0]!.n.role;
    const base = RING[role] ?? 160;
    // Rings this arc needs: as many bubbles on each as fit side by side.
    const r = webRadius(g[0]!.n);
    const perRing = (ring: number) =>
      Math.max(1, Math.floor((span * (base + ring * RING_STEP)) / (2 * r + LABEL_GAP + GAP)));
    let placed = 0;
    let ring = 0;
    const sorted = [...g].sort(
      (a, b) => (role === "possible" || role === "bundle" ? b.n.pct - a.n.pct : 0) || a.i - b.i,
    );
    while (placed < sorted.length) {
      const cap = Math.min(perRing(ring), sorted.length - placed);
      const radius = base + ring * RING_STEP;
      for (let k = 0; k < cap; k++) {
        const item = sorted[placed + k]!;
        // Spread evenly, staggered half a step on every other ring.
        const t = cap === 1 ? 0.5 : (k + (ring % 2 ? 0.75 : 0.25)) / cap;
        const angle = start + span * (0.06 + 0.88 * t);
        // A weaker Possible Side sits a little further out.
        const drift = role === "possible" || role === "bundle" ? (100 - Math.min(100, item.n.pct)) * 0.25 : 0;
        out.set(item.n.wallet, {
          x: Math.cos(angle) * (radius + drift),
          y: Math.sin(angle) * (radius + drift),
        });
      }
      placed += cap;
      ring += 1;
    }
    start += span;
  });
  return out;
}

/** Pushes overlapping bubbles apart, each pulled back toward its place; the hub stays put. */
function relax(nodes: PlacedNode[], home: Map<string, { x: number; y: number }>, rounds = 200) {
  for (let round = 0; round < rounds; round++) {
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]!;
        const b = nodes[j]!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        // Room for the names under the bubbles, too.
        const min = a.r + b.r + LABEL_GAP;
        if (d >= min) continue;
        if (d < 0.01) {
          dx = Math.cos(i + j);
          dy = Math.sin(i + j);
          d = 1;
        }
        const push = (min - d) / 2;
        const ux = dx / d;
        const uy = dy / d;
        if (a.role === "hub") {
          b.x += ux * push * 2;
          b.y += uy * push * 2;
        } else if (b.role === "hub") {
          a.x -= ux * push * 2;
          a.y -= uy * push * 2;
        } else {
          a.x -= ux * push;
          a.y -= uy * push;
          b.x += ux * push;
          b.y += uy * push;
        }
      }
    }
    // The last rounds only push apart, so nothing is left overlapping by the pull home.
    if (round >= rounds - 40) continue;
    for (const n of nodes) {
      const h = home.get(n.wallet);
      if (!h || n.role === "hub") continue;
      n.x += (h.x - n.x) * 0.04;
      n.y += (h.y - n.y) * 0.04;
    }
  }
}

/** Where a node's ties meet it; parallel ties between one pair bow apart. */
function curve(
  a: { x: number; y: number },
  b: { x: number; y: number },
  bend: number,
): { d: string; mid: { x: number; y: number; angle: number } } {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const cx = mx + (-dy / len) * bend;
  const cy = my + (dx / len) * bend;
  // The curve's middle (t = 0.5) and its heading there.
  const px = 0.25 * a.x + 0.5 * cx + 0.25 * b.x;
  const py = 0.25 * a.y + 0.5 * cy + 0.25 * b.y;
  const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  const f = (v: number) => Math.round(v * 10) / 10;
  return { d: `M${f(a.x)} ${f(a.y)} Q${f(cx)} ${f(cy)} ${f(b.x)} ${f(b.y)}`, mid: { x: px, y: py, angle } };
}

/** The whole map: every bubble placed, every tie drawn, and the box round them. */
export function layoutWeb(web: Pick<SideWeb, "hub" | "nodes" | "edges">): WebLayout {
  const home = arcPlaces(web.nodes);
  const placed: PlacedNode[] = web.nodes.map((n) => {
    const at = n.role === "hub" ? { x: 0, y: 0 } : (home.get(n.wallet) ?? { x: 0, y: 0 });
    const moverOnly = (n.role === "possible" || n.role === "bundle") && n.pct <= 0;
    return { ...n, ...at, r: webRadius(n), moverOnly };
  });
  const byWallet = new Map(placed.map((n) => [n.wallet, n]));
  // A shared funder sits out past the middle of the wallets it paid.
  for (const f of placed.filter((n) => n.role === "funder")) {
    const paid = web.edges
      .filter((e) => e.type === "funded" && e.from === f.wallet)
      .map((e) => byWallet.get(e.to))
      .filter((n): n is PlacedNode => !!n);
    if (paid.length === 0) continue;
    const cx = paid.reduce((s, n) => s + n.x, 0) / paid.length;
    const cy = paid.reduce((s, n) => s + n.y, 0) / paid.length;
    const d = Math.hypot(cx, cy) || 1;
    const out = Math.max(...paid.map((n) => Math.hypot(n.x, n.y))) + 46;
    f.x = (cx / d) * out;
    f.y = (cy / d) * out;
    home.set(f.wallet, { x: f.x, y: f.y });
  }
  relax(placed, home);

  // Ties between the same pair fan out, each with its own bow.
  const pairCount = new Map<string, number>();
  const pairKey = (e: WebEdge) => (e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`);
  for (const e of web.edges) pairCount.set(pairKey(e), (pairCount.get(pairKey(e)) ?? 0) + 1);
  const seen = new Map<string, number>();
  const edges: PlacedEdge[] = [];
  for (const e of web.edges) {
    const a = byWallet.get(e.from);
    const b = byWallet.get(e.to);
    if (!a || !b) continue;
    const key = pairKey(e);
    const n = pairCount.get(key) ?? 1;
    const i = seen.get(key) ?? 0;
    seen.set(key, i + 1);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    // A tie to the hub bows gently; one between two side wallets bows more, so it reads apart from the spokes.
    const touchesHub = a.role === "hub" || b.role === "hub";
    const baseBend = touchesHub ? len * 0.06 : len * 0.22;
    // Ordered so a pair's ties fan out the same way whichever end is `from`.
    const flip = e.from < e.to ? 1 : -1;
    const bend = (baseBend + (i - (n - 1) / 2) * 16) * flip;
    edges.push({ ...e, ...curve(a, b, bend), width: tieWidth(e) });
  }

  const pad = 28;
  const minX = Math.min(...placed.map((n) => n.x - n.r)) - pad;
  const maxX = Math.max(...placed.map((n) => n.x + n.r)) + pad;
  // Room under the lowest bubbles for their names.
  const minY = Math.min(...placed.map((n) => n.y - n.r)) - pad;
  const maxY = Math.max(...placed.map((n) => n.y + n.r)) + pad + 12;
  // Never narrower than a square: a small web stays centred, not stretched.
  const w = Math.max(maxX - minX, maxY - minY, 260);
  const h = Math.max(maxY - minY, 240);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return { nodes: placed, edges, box: { x: cx - w / 2, y: cy - h / 2, w, h } };
}

/** "12 wallets", "1 wallet". */
export const walletCount = (n: number) => `${n.toLocaleString("en-US")} wallet${n === 1 ? "" : "s"}`;

/**
 * What one tie says from the picked wallet's side, as the words before and after the other
 * wallet's name: ["Funded by ", " · 1.50 SOL"], ["Bought 96% of the same coins as ", " within minutes, over 48h"].
 */
export function tieText(e: WebEdge, me: string): [string, string] {
  switch (e.type) {
    case "known":
      return ["Known Side: one of ", "'s own wallets"];
    case "funded": {
      const sol = e.sol ? ` · ${e.sol >= 10 ? e.sol.toFixed(0) : e.sol.toFixed(2)} SOL` : "";
      return [e.from === me ? "Paid the first SOL of " : "First SOL paid by ", sol];
    }
    case "trades":
      return [
        `Bought ${Math.round(e.pct ?? 0)}% of the same coins as `,
        ` within minutes${e.hours ? `, over ${e.hours}h` : ""}`,
      ];
    default:
      return [
        e.count ? `${e.count} coin transfer${e.count === 1 ? "" : "s"} with ` : "Coin transfers with ",
        "",
      ];
  }
}
