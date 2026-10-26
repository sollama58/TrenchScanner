import { edgeSol, type AsylEdge, type AsylGraph, type AsylNode } from "./graph";

/**
 * Analyst Mode (user ask 2026-10-26): the map drawn as an investigator's flowchart instead of
 * bubbles. Every wallet is a box with its address, links run at right angles with the money on
 * them, and the map reads top to bottom: who paid whom, who deployed what, and who traded it.
 * Wallets that did nothing on the map but trade or hold one coin fold into that coin's box ("121
 * addresses that traded $SPIKE"), side wallets of one person sit inside one dashed outline, and
 * exchanges and services are small S circles.
 *
 * Everything here is pure geometry, so the screen (AnalystLayer.tsx) and the share image
 * (renderAnalystCard) draw the same picture.
 */

/** Adds to a list in a map, making the list on first use. */
function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const l = m.get(k);
  if (l) l.push(v);
  else m.set(k, [v]);
}

export type Role = "wallet" | "dev" | "group" | "coin" | "service";

/** What the map shows in Analyst Mode: the graph with coin traders folded into their coin. */
export interface AnalystView {
  graph: AsylGraph;
  /** A coin's folded wallets, by coin. */
  groups: Map<string, string[]>;
  /** Each folded wallet's coin. */
  memberOf: Map<string, string>;
  /** Whether a coin's folded wallets traded it, hold it, or both. */
  groupVerb: Map<string, string>;
}

/** Wallets that mark a map and stay their own box, even when all they did was trade one coin. */
const KEEP_TAGS = new Set(["mine", "kol", "kol-side", "dev", "exchange"]);
/** A coin folds its traders once it has this many. */
const FOLD_MIN = 2;

export function analystView(g: AsylGraph, focus: string | null): AnalystView {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const touching = new Map<string, AsylEdge[]>();
  for (const e of g.edges) {
    if (!touching.has(e.a)) touching.set(e.a, []);
    if (!touching.has(e.b)) touching.set(e.b, []);
    touching.get(e.a)!.push(e);
    touching.get(e.b)!.push(e);
  }
  const candidates = new Map<string, string[]>();
  for (const n of g.nodes) {
    if (n.kind !== "wallet" || n.id === focus || n.name || n.tags.some((t) => KEEP_TAGS.has(t))) continue;
    const es = touching.get(n.id) ?? [];
    if (!es.length || es.some((e) => e.kind !== "traded" && e.kind !== "holds")) continue;
    const coins = new Set(es.map((e) => (e.a === n.id ? e.b : e.a)));
    if (coins.size !== 1) continue;
    const coin = [...coins][0]!;
    if (byId.get(coin)?.kind !== "token") continue;
    push(candidates, coin, n.id);
  }
  const groups = new Map<string, string[]>();
  const memberOf = new Map<string, string>();
  const groupVerb = new Map<string, string>();
  for (const [coin, members] of candidates) {
    if (members.length < FOLD_MIN) continue;
    groups.set(coin, members);
    const set = new Set(members);
    let traded = false;
    let held = false;
    for (const e of touching.get(coin) ?? []) {
      if (!set.has(e.a) && !set.has(e.b)) continue;
      if (e.kind === "traded") traded = true;
      else held = true;
    }
    groupVerb.set(coin, traded && held ? "traded or hold" : held ? "hold" : "traded");
    for (const m of members) memberOf.set(m, coin);
  }
  if (!memberOf.size) return { graph: g, groups, memberOf, groupVerb };
  return {
    graph: {
      nodes: g.nodes.filter((n) => !memberOf.has(n.id)),
      edges: g.edges.filter((e) => !memberOf.has(e.a) && !memberOf.has(e.b)),
    },
    groups,
    memberOf,
    groupVerb,
  };
}

/** A box as the flowchart draws it, centred on its node's place. */
export interface ABox {
  id: string;
  role: Role;
  w: number;
  h: number;
  /** The box's text, one line each: the address, or a group's count and coin. */
  lines: string[];
  /** Above the box: who it is ("$BOP dev", a label), or null. */
  caption: string | null;
  tone: "dev" | "kol" | "focus" | "named" | "service" | null;
  /** The map's focus: drawn in red, as the one the map is about. */
  focus: boolean;
}

export const BOX_W = 136;
export const BOX_H = 44;
const GROUP_W = 164;
const GROUP_H = 66;
const SERVICE = 30;

/** The address as the boxes show it: its first six characters. */
export const boxAddr = (id: string) => id.slice(0, 6);

const bare = (s: string) => s.replace(/^\$/, "").trim().toLowerCase();
const coinName = (n: AsylNode) => n.name ?? (n.title ? `$${n.title}` : boxAddr(n.id));

export function boxesOf(v: AnalystView, focus: string | null): Map<string, ABox> {
  const byId = new Map(v.graph.nodes.map((n) => [n.id, n]));
  const deployed = new Map<string, string[]>();
  for (const e of v.graph.edges)
    if (e.kind === "created" && byId.get(e.b)?.kind === "token")
      push(deployed, e.a, coinName(byId.get(e.b)!));
  const out = new Map<string, ABox>();
  for (const n of v.graph.nodes) {
    const isFocus = n.id === focus;
    if (n.kind === "token") {
      const members = v.groups.get(n.id);
      out.set(n.id, {
        id: n.id,
        role: members ? "group" : "coin",
        w: GROUP_W,
        h: members ? GROUP_H : BOX_H,
        lines: members
          ? [
              `${members.length} address${members.length === 1 ? "" : "es"}`,
              `that ${v.groupVerb.get(n.id) ?? "traded"}`,
              coinName(n),
            ]
          : [coinName(n)],
        // A coin's own name over its box, unless it only says the ticker again.
        caption: members || !n.title || bare(n.title) === bare(coinName(n)) ? null : n.title,
        tone: null,
        focus: isFocus,
      });
      continue;
    }
    const coins = deployed.get(n.id);
    const service = n.tags.includes("exchange");
    const dev = !!coins?.length || n.tags.includes("dev");
    const kol = n.tags.includes("kol") || n.tags.includes("kol-side");
    out.set(n.id, {
      id: n.id,
      role: service ? "service" : dev ? "dev" : "wallet",
      w: service ? SERVICE : BOX_W,
      h: service ? SERVICE : BOX_H,
      lines: service ? ["S"] : [boxAddr(n.id)],
      caption: service
        ? (n.name ?? "Exchange")
        : coins?.length
          ? `${coins[0]}${coins.length > 1 ? ` +${coins.length - 1}` : ""} dev`
          : n.name
            ? kol && !n.name.startsWith("@")
              ? `@${n.name}`
              : n.name
            : dev
              ? "dev"
              : null,
      tone: service
        ? "service"
        : isFocus
          ? "focus"
          : coins?.length || dev
            ? "dev"
            : kol
              ? "kol"
              : n.name
                ? "named"
                : null,
      focus: isFocus,
    });
  }
  return out;
}

type Point = { x: number; y: number };

/** Room between boxes in a row, and between rows (for a caption, a label and the turn of a line). */
export const COL_GAP = 36;
export const ROW_GAP = 104;
/** A row holds at most this many boxes; a longer one wraps onto the next. */
const ROW_MAX = 6;

/**
 * Lays the flowchart out top to bottom (a layered layout): money flows down, from whoever paid to
 * whoever was paid, into the coins they deployed, bought and hold: a coin sits under its deployer
 * and the wallets that trade or hold it. Rows are ordered to keep lines short and uncrossed, and side wallets of one person sit
 * together. Boxes in `held` (dragged there by the reader) keep their place.
 */
export function analystLayout(
  g: AsylGraph,
  boxes: Map<string, ABox>,
  held: ReadonlyMap<string, Point> = new Map(),
): Map<string, Point> {
  const ids = g.nodes.map((n) => n.id);
  const kind = new Map(g.nodes.map((n) => [n.id, n.kind]));
  const down = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]));
  const add = (u: string, v: string) => {
    if (u !== v && down.has(u) && down.has(v)) down.get(u)!.add(v);
  };
  for (const e of g.edges) {
    if (e.kind === "funded" || e.kind === "transfer" || e.kind === "created") add(e.a, e.b);
    else if (e.kind === "traded" || e.kind === "holds") {
      if (kind.get(e.a) === "token") add(e.b, e.a);
      else add(e.a, e.b);
    }
  }
  // Break cycles (A paid B, B paid A): a line that closes one is left out of the layering.
  const seen = new Map<string, 1 | 2>();
  const inCount = new Map<string, number>();
  for (const vs of down.values()) for (const v of vs) inCount.set(v, (inCount.get(v) ?? 0) + 1);
  const indeg = (id: string) => inCount.get(id) ?? 0;
  const starts = [...ids].sort((a, b) => indeg(a) - indeg(b) || down.get(b)!.size - down.get(a)!.size);
  const visit = (u: string) => {
    seen.set(u, 1);
    for (const v of [...down.get(u)!]) {
      const s = seen.get(v);
      if (s === 1) down.get(u)!.delete(v);
      else if (!s) visit(v);
    }
    seen.set(u, 2);
  };
  for (const id of starts) if (!seen.has(id)) visit(id);

  // Longest path from the top, in topological order.
  const up = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const [u, vs] of down) for (const v of vs) up.get(v)!.push(u);
  const order: string[] = [];
  const left = new Map(ids.map((id) => [id, up.get(id)!.length]));
  const queue = ids.filter((id) => left.get(id) === 0);
  while (queue.length) {
    const u = queue.shift()!;
    order.push(u);
    for (const v of down.get(u)!) {
      left.set(v, left.get(v)! - 1);
      if (left.get(v) === 0) queue.push(v);
    }
  }
  const layer = new Map<string, number>();
  for (const u of order) layer.set(u, Math.max(0, ...up.get(u)!.map((p) => layer.get(p)! + 1)));
  // A box at the top with lines only downwards sits just over the nearest one it reaches.
  for (const u of [...order].reverse()) {
    if (up.get(u)!.length || !down.get(u)!.size) continue;
    layer.set(u, Math.max(0, Math.min(...[...down.get(u)!].map((v) => layer.get(v)!)) - 1));
  }
  // Boxes the layering doesn't reach (bought together, side wallets) go beside what they're tied to.
  const adj = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]));
  for (const e of g.edges) {
    if (!adj.has(e.a) || !adj.has(e.b) || e.a === e.b) continue;
    adj.get(e.a)!.add(e.b);
    adj.get(e.b)!.add(e.a);
  }
  const loose = (id: string) => !up.get(id)!.length && !down.get(id)!.size;
  for (let pass = 0; pass < 3; pass++)
    for (const id of ids) {
      if (!loose(id)) continue;
      const near = [...adj.get(id)!].filter((n) => !loose(n) || pass > 0).map((n) => layer.get(n) ?? 0);
      layer.set(id, near.length ? Math.min(...near) : 0);
    }

  // Side wallets of one person: one family, on one row, side by side.
  const family = familiesOf(g);
  for (const members of family.values()) {
    const row = Math.min(...members.map((m) => layer.get(m) ?? 0));
    for (const m of members) layer.set(m, row);
  }
  const familyOf = new Map<string, string>();
  for (const [root, members] of family) for (const m of members) familyOf.set(m, root);

  // Rows, first in the order a walk from the top meets them; then sorted by where their lines go.
  const rows = new Map<number, string[]>();
  const walked: string[] = [];
  const met = new Set<string>();
  const walk = (u: string) => {
    if (met.has(u)) return;
    met.add(u);
    walked.push(u);
    for (const v of [...adj.get(u)!].sort()) if ((layer.get(v) ?? 0) >= (layer.get(u) ?? 0)) walk(v);
  };
  for (const id of [...ids].sort(
    (a, b) => (layer.get(a) ?? 0) - (layer.get(b) ?? 0) || adj.get(b)!.size - adj.get(a)!.size,
  ))
    walk(id);
  for (const id of walked) {
    const l = layer.get(id) ?? 0;
    push(rows, l, id);
  }
  const levels = [...rows.keys()].sort((a, b) => a - b);
  const width = (id: string) => boxes.get(id)?.w ?? BOX_W;
  const x = new Map<string, number>();
  const place = (row: string[], want: Map<string, number>) => {
    const xs: number[] = [];
    row.forEach((id, i) => {
      const w = want.get(id) ?? 0;
      xs.push(i === 0 ? w : Math.max(w, xs[i - 1]! + (width(row[i - 1]!) + width(id)) / 2 + COL_GAP));
    });
    // Keep the row centred where its boxes want to be.
    const shift = row.reduce((s, id, i) => s + (xs[i]! - (want.get(id) ?? 0)), 0) / Math.max(1, row.length);
    row.forEach((id, i) => x.set(id, xs[i]! - shift));
  };
  for (const l of levels) {
    const row = rows.get(l)!;
    const want = new Map<string, number>();
    let at = -((row.length - 1) * (BOX_W + COL_GAP)) / 2;
    for (const id of row) {
      want.set(id, at);
      at += BOX_W + COL_GAP;
    }
    place(row, want);
  }
  const mean = (id: string, from: (n: string) => boolean) => {
    const xs = [...adj.get(id)!].filter(from).map((n) => x.get(n)!);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  // Sweeps down and up: each row sorted under the boxes it's tied to above (or below), and placed there.
  for (let sweep = 0; sweep < 8; sweep++) {
    const downwards = sweep % 2 === 0;
    const seq = downwards ? levels : [...levels].reverse();
    for (const l of seq) {
      const row = rows.get(l)!;
      const want = new Map<string, number>();
      for (const id of row) {
        const side = mean(id, (n) => (downwards ? layer.get(n)! < l : layer.get(n)! > l));
        const any = side ?? mean(id, (n) => layer.get(n) !== l);
        want.set(id, any ?? x.get(id)!);
      }
      row.sort((a, b) => want.get(a)! - want.get(b)! || (a < b ? -1 : 1));
      // A family keeps together, where its first member falls.
      const sorted: string[] = [];
      const done = new Set<string>();
      for (const id of row) {
        if (done.has(id)) continue;
        const root = familyOf.get(id);
        const members = root ? row.filter((m) => familyOf.get(m) === root) : [id];
        for (const m of members) {
          sorted.push(m);
          done.add(m);
        }
      }
      rows.set(l, sorted);
      place(sorted, want);
    }
  }

  // A long row wraps; then each row goes down the page, as tall as its tallest box.
  const out = new Map<string, Point>();
  let y = 0;
  let prevH = 0;
  for (const l of levels) {
    const row = rows.get(l)!;
    // Wrapped where a family of side wallets isn't split, unless one family is wider than a row.
    const parts: string[][] = [[]];
    for (let i = 0; i < row.length;) {
      const root = familyOf.get(row[i]!);
      let j = i + 1;
      while (root && j < row.length && familyOf.get(row[j]!) === root) j++;
      const run = row.slice(i, j);
      const last = parts[parts.length - 1]!;
      if (last.length && last.length + run.length > ROW_MAX) parts.push([]);
      for (const id of run) {
        if (parts[parts.length - 1]!.length >= ROW_MAX) parts.push([]);
        parts[parts.length - 1]!.push(id);
      }
      i = j;
    }
    for (const part of parts) {
      if (!part.length) continue;
      if (parts.length > 1) {
        const want = new Map(part.map((id) => [id, x.get(id)!]));
        // A wrapped row is packed afresh, centred where its boxes wanted to be.
        part.forEach((id, k) => want.set(id, (k - (part.length - 1) / 2) * (BOX_W + COL_GAP)));
        const centre = part.reduce((s, id) => s + x.get(id)!, 0) / part.length;
        for (const id of part) want.set(id, want.get(id)! + centre);
        place(part, want);
      }
      const h = Math.max(...part.map((id) => boxes.get(id)?.h ?? BOX_H));
      y += out.size ? prevH / 2 + ROW_GAP + h / 2 : 0;
      prevH = h;
      for (const id of part) out.set(id, { x: x.get(id)!, y });
    }
  }
  // Centred on the origin, as the free layout is.
  const xs = [...out.values()].map((p) => p.x);
  const ys = [...out.values()].map((p) => p.y);
  const cx = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : 0;
  const cy = ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : 0;
  for (const [id, p] of out)
    out.set(id, held.get(id) ?? { x: Math.round(p.x - cx), y: Math.round(p.y - cy) });
  return out;
}

/** Side wallets of one person, by union over their side links: families of two or more. */
export function familiesOf(g: AsylGraph): Map<string, string[]> {
  const parent = new Map<string, string>();
  const find = (u: string): string => {
    while (parent.has(u) && parent.get(u) !== u) u = parent.get(u)!;
    return u;
  };
  const ids = new Set(g.nodes.map((n) => n.id));
  for (const e of g.edges) {
    if (e.kind !== "side" || !ids.has(e.a) || !ids.has(e.b)) continue;
    if (!parent.has(e.a)) parent.set(e.a, e.a);
    if (!parent.has(e.b)) parent.set(e.b, e.b);
    const ra = find(e.a);
    const rb = find(e.b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const out = new Map<string, string[]>();
  for (const id of parent.keys()) {
    const r = find(id);
    push(out, r, id);
  }
  for (const [r, m] of out) if (m.length < 2) out.delete(r);
  return out;
}

/** Money as the flowchart writes it: in dollars when SOL's price is known ("$13k"), else in SOL. */
export function money(sol: number, solUsd: number | null): string {
  if (solUsd) {
    const usd = sol * solUsd;
    if (usd >= 1e6) return `$${trim(usd / 1e6, usd < 1e7 ? 1 : 0)}M`;
    if (usd >= 1e3) return `$${trim(usd / 1e3, usd < 1e4 ? 1 : 0)}k`;
    return `$${Math.round(usd)}`;
  }
  return `${trim(sol, sol < 10 ? 2 : sol < 100 ? 1 : 0)} SOL`;
}
const trim = (v: number, dp: number) => v.toFixed(dp).replace(/\.0+$|(\.\d*?)0+$/, "$1");

/** What a link says along it: the money, else what it is. */
export function linkText(e: AsylEdge, solUsd: number | null): string {
  switch (e.kind) {
    case "funded": {
      const s = edgeSol(e);
      return s !== null && s > 0 ? money(s, solUsd) : "funded";
    }
    case "transfer":
    case "traded": {
      const s = edgeSol(e);
      if (s !== null && s > 0) return money(s, solUsd);
      return e.kind === "traded" ? "traded" : "sent";
    }
    case "holds":
      return e.pct !== undefined && e.pct !== null ? `${trim(e.pct, e.pct < 10 ? 1 : 0)}%` : "holds";
    case "cotrade":
      return e.shared ? `${e.shared} coin${e.shared === 1 ? "" : "s"}` : "bought together";
    case "created":
      return "deployed";
    case "side":
      return "side";
  }
}

/** How a link is drawn: white for money, dashed for a time and size match, green for a deploy. */
export function linkStyle(e: AsylEdge): { colour: string; dash: string | null; arrow: boolean } {
  switch (e.kind) {
    case "created":
      return { colour: ANALYST.dev, dash: null, arrow: true };
    case "cotrade":
      return { colour: ANALYST.ink, dash: "7 6", arrow: false };
    case "side":
      return { colour: ANALYST.ink, dash: "3 5", arrow: false };
    case "traded":
    case "holds":
      return { colour: ANALYST.group, dash: null, arrow: false };
    default:
      return { colour: ANALYST.ink, dash: null, arrow: true };
  }
}

/** Analyst Mode's palette: a near-black page, white boxes, green devs, blue trader groups. */
export const ANALYST = {
  page: "#0b0b0c",
  ink: "#f2f2f2",
  muted: "#a3a3a3",
  dev: "#3fbf5f",
  group: "#4aa3ff",
  focus: "#ff3b3b",
  kol: "#ffd34d",
  select: "#ff9d3b",
  font: '"JetBrains Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace',
};

/** A link as drawn: the corners it runs through, and where its text sits. */
export interface ARoute {
  edge: AsylEdge;
  points: [number, number][];
  text: string;
  /** Where the text sits, and which way it runs off that point. */
  tx: number;
  ty: number;
  anchor: "start" | "end" | "middle";
}

type Side = "top" | "bottom" | "left" | "right";

/**
 * Right-angled lines between boxes. A line leaves the bottom of the upper box and enters the top
 * of the lower one (or runs side to side within a row), turning in the gap just over its target;
 * lines sharing a side of a box spread out along it, so each can be followed.
 */
export function routesOf(
  g: AsylGraph,
  boxes: Map<string, ABox>,
  pos: ReadonlyMap<string, Point>,
  solUsd: number | null,
): ARoute[] {
  type Plan = { e: AsylEdge; a: Point; b: Point; ab: ABox; bb: ABox; sa: Side; sb: Side };
  const plans: Plan[] = [];
  for (const e of g.edges) {
    const a = pos.get(e.a);
    const b = pos.get(e.b);
    const ab = boxes.get(e.a);
    const bb = boxes.get(e.b);
    if (!a || !b || !ab || !bb || e.a === e.b) continue;
    const sameRow = Math.abs(a.y - b.y) < (ab.h + bb.h) / 4;
    let sa: Side;
    let sb: Side;
    if (sameRow) {
      sa = b.x >= a.x ? "right" : "left";
      sb = b.x >= a.x ? "left" : "right";
    } else {
      sa = b.y > a.y ? "bottom" : "top";
      sb = b.y > a.y ? "top" : "bottom";
    }
    plans.push({ e, a, b, ab, bb, sa, sb });
  }
  // Ports: the lines on one side of a box, spread along it in the order of where they go.
  const ports = new Map<string, { plan: Plan; end: "a" | "b"; toward: number }[]>();
  for (const p of plans) {
    const horiz = p.sa === "left" || p.sa === "right";
    const ka = `${p.e.a}|${p.sa}`;
    const kb = `${p.e.b}|${p.sb}`;
    push(ports, ka, { plan: p, end: "a", toward: horiz ? p.b.y : p.b.x });
    push(ports, kb, { plan: p, end: "b", toward: horiz ? p.a.y : p.a.x });
  }
  type Port = { off: number; i: number; n: number };
  const offset = new Map<Plan, { a: Port; b: Port }>();
  for (const [key, list] of ports) {
    list.sort((x, y) => x.toward - y.toward);
    const box = list[0]!.end === "a" ? list[0]!.plan.ab : list[0]!.plan.bb;
    const side = key.slice(key.lastIndexOf("|") + 1) as Side;
    const span = (side === "left" || side === "right" ? box.h : box.w) * (box.role === "service" ? 0 : 0.7);
    const step = list.length > 1 ? Math.min(22, span / (list.length - 1)) : 0;
    list.forEach((port, i) => {
      const o = offset.get(port.plan) ?? { a: { off: 0, i: 0, n: 1 }, b: { off: 0, i: 0, n: 1 } };
      o[port.end] = { off: (i - (list.length - 1) / 2) * step, i, n: list.length };
      offset.set(port.plan, o);
    });
  }
  const at = (p: Point, box: ABox, side: Side, off: number): [number, number] => {
    if (box.role === "service") {
      // A circle: the line meets its rim.
      const r = box.w / 2;
      return side === "top"
        ? [p.x + off, p.y - r]
        : side === "bottom"
          ? [p.x + off, p.y + r]
          : side === "left"
            ? [p.x - r, p.y + off]
            : [p.x + r, p.y + off];
    }
    switch (side) {
      case "top":
        return [p.x + off, p.y - box.h / 2];
      case "bottom":
        return [p.x + off, p.y + box.h / 2];
      case "left":
        return [p.x - box.w / 2, p.y + off];
      case "right":
        return [p.x + box.w / 2, p.y + off];
    }
  };
  const out: ARoute[] = [];
  for (const p of plans) {
    const none = { off: 0, i: 0, n: 1 };
    const o = offset.get(p) ?? { a: none, b: none };
    const s = at(p.a, p.ab, p.sa, o.a.off);
    const t = at(p.b, p.bb, p.sb, o.b.off);
    const text = linkText(p.e, solUsd);
    const points: [number, number][] = [s];
    let tx: number;
    let ty: number;
    let anchor: ARoute["anchor"] = "start";
    if (p.sa === "left" || p.sa === "right") {
      if (Math.abs(s[1] - t[1]) > 1) {
        const mx = (s[0] + t[0]) / 2;
        points.push([mx, s[1]], [mx, t[1]]);
      }
      points.push(t);
      tx = (s[0] + t[0]) / 2;
      ty = Math.min(s[1], t[1]) - 7;
      anchor = "middle";
    } else {
      const downwards = p.sa === "bottom";
      // The turn sits in the gap over (or under) the target, clear of the target's caption.
      const gap = Math.max(26, Math.min(ROW_GAP * 0.55, Math.abs(t[1] - s[1]) / 2));
      const my = downwards ? t[1] - gap : t[1] + gap;
      if (Math.abs(s[0] - t[0]) > 1) points.push([s[0], my], [t[0], my]);
      points.push(t);
      // The text beside a straight run at whichever end has fewer lines on that side of its box,
      // stepped up and down where lines sit close, so neighbouring texts don't overprint.
      const nearSource = o.a.n < o.b.n;
      const port = nearSource ? o.a : o.b;
      const stagger = port.n > 1 ? ((port.i % 3) - 1) * 13 : 0;
      tx = (nearSource ? s[0] : t[0]) + 6;
      ty = (nearSource ? (s[1] + my) / 2 : (my + t[1]) / 2) + 4 + stagger;
    }
    out.push({ edge: p.e, points, text, tx, ty, anchor });
  }
  return out;
}

/** A dashed outline round each family of side wallets. */
export function familyFrames(
  g: AsylGraph,
  boxes: Map<string, ABox>,
  pos: ReadonlyMap<string, Point>,
): { ids: string[]; x: number; y: number; w: number; h: number }[] {
  const out: { ids: string[]; x: number; y: number; w: number; h: number }[] = [];
  for (const members of familiesOf(g).values()) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const id of members) {
      const p = pos.get(id);
      const b = boxes.get(id);
      if (!p || !b) continue;
      minX = Math.min(minX, p.x - b.w / 2);
      maxX = Math.max(maxX, p.x + b.w / 2);
      // Room for the caption over the box (under a service's circle).
      minY = Math.min(minY, p.y - b.h / 2 - (b.caption && b.role !== "service" ? 22 : 0));
      maxY = Math.max(maxY, p.y + b.h / 2 + (b.caption && b.role === "service" ? 18 : 0));
    }
    if (!Number.isFinite(minX)) continue;
    const pad = 14;
    out.push({
      ids: members,
      x: minX - pad,
      y: minY - pad,
      w: maxX - minX + pad * 2,
      h: maxY - minY + pad * 2,
    });
  }
  return out;
}

/** The colour a box is outlined in. */
export function boxColour(b: ABox): string {
  if (b.focus) return ANALYST.focus;
  if (b.role === "dev") return ANALYST.dev;
  if (b.role === "group" || b.role === "coin") return ANALYST.group;
  return ANALYST.ink;
}

/** The colour of a box's caption. */
export function captionColour(b: ABox): string {
  switch (b.tone) {
    case "focus":
      return ANALYST.focus;
    case "kol":
      return ANALYST.kol;
    case "service":
      return ANALYST.muted;
    default:
      return ANALYST.ink;
  }
}

/** Everything Analyst Mode draws, for a map as laid out. */
export interface AnalystScene {
  view: AnalystView;
  boxes: Map<string, ABox>;
  routes: ARoute[];
  frames: ReturnType<typeof familyFrames>;
}

export function analystScene(
  v: AnalystView,
  boxes: Map<string, ABox>,
  pos: ReadonlyMap<string, Point>,
  solUsd: number | null,
): AnalystScene {
  return {
    view: v,
    boxes,
    routes: routesOf(v.graph, boxes, pos, solUsd),
    frames: familyFrames(v.graph, boxes, pos),
  };
}

/** The scene's extent, captions and frames included. */
export function sceneBounds(scene: AnalystScene, pos: ReadonlyMap<string, Point>) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [id, b] of scene.boxes) {
    const p = pos.get(id);
    if (!p) continue;
    minX = Math.min(minX, p.x - b.w / 2);
    maxX = Math.max(maxX, p.x + b.w / 2);
    minY = Math.min(minY, p.y - b.h / 2 - (b.caption && b.role !== "service" ? 24 : 0));
    maxY = Math.max(maxY, p.y + b.h / 2 + (b.caption && b.role === "service" ? 20 : 0));
  }
  for (const f of scene.frames) {
    minX = Math.min(minX, f.x);
    minY = Math.min(minY, f.y);
    maxX = Math.max(maxX, f.x + f.w);
    maxY = Math.max(maxY, f.y + f.h);
  }
  if (!Number.isFinite(minX)) return { minX: -100, minY: -100, maxX: 100, maxY: 100 };
  return { minX, minY, maxX, maxY };
}
