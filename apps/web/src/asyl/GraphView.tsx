import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import {
  clusterOf,
  DEFAULT_TIME_LABELS,
  EDGE_KINDS,
  EDGE_LABEL,
  edgeTimeFull,
  edgeTimeLabel,
  nodeName,
  TAG_LABEL,
  TIMED_KINDS,
  textBoxSize,
  type Drawings,
  type TimeLabels,
  type TimedKind,
  type AsylEdge,
  type AsylEdgeKind,
  type AsylGraph,
  type AsylNode,
} from "./graph";
import {
  bounds,
  gridCell,
  placeNew,
  snapToGrid,
  spreadForGrid,
  step,
  type Cell,
  type LayoutState,
} from "./layout";
import { avatarUrl } from "./asylApi";
import { tokenImageSources } from "../format";

/**
 * The map: every node a bubble (a wallet) or a tile (a coin), every link a line coloured by its
 * kind, with an arrow where it has a direction. Drag the background to pan, the wheel or a pinch
 * to zoom, drag a bubble to move it (it stays where it is put), click to select, double-click to
 * open what it is tied to. Laid out by layout.ts, a step per frame until it settles.
 */

export const EDGE_COLOUR: Record<AsylEdgeKind, string> = {
  funded: "#ffb547",
  transfer: "#ff4d4d",
  side: "#e38cff",
  cotrade: "#6fd6c4",
  created: "#fff27a",
  traded: "#79a8ff",
  holds: "#8f8a86",
};

export type EdgeHead = "arrow" | "open" | "diamond" | "dot";

/**
 * How each kind of link is drawn, so no two read alike even without their colours (user ask
 * 2026-10-24): a line pattern and a mark at the far end, and what it means, for the legend.
 */
export const EDGE_STYLE: Record<AsylEdgeKind, { dash?: string; head?: EdgeHead; meaning: string }> = {
  funded: { head: "arrow", meaning: "Paid the wallet its first SOL" },
  transfer: { dash: "6 3", head: "arrow", meaning: "Sent it SOL or coins" },
  side: { dash: "12 4 2 4", head: "open", meaning: "A side wallet of the same person" },
  cotrade: { dash: "1.5 4", meaning: "Bought the same coins within minutes" },
  created: { dash: "10 4", head: "diamond", meaning: "Deployed the coin: a gold, glowing line" },
  traded: { meaning: "Bought or sold the coin" },
  holds: { head: "dot", meaning: "Holds the coin now" },
};

/** The mark at a link's far end, in a 10×10 box pointing right. */
export function HeadShape({ head, colour }: { head: EdgeHead; colour: string }) {
  switch (head) {
    case "arrow":
      return <path d="M0 0 L10 5 L0 10 z" fill={colour} />;
    case "open":
      return <path d="M1 1 L9 5 L1 9" fill="none" stroke={colour} strokeWidth={2} />;
    case "diamond":
      return <path d="M0 5 L5 0.5 L10 5 L5 9.5 z" fill={colour} />;
    case "dot":
      return <circle cx={5} cy={5} r={4} fill={colour} />;
  }
}

/** A short sample of a kind of link, as the map draws it. */
export function LinkSwatch({ kind, chain = false }: { kind: AsylEdgeKind; chain?: boolean }) {
  const st = EDGE_STYLE[kind];
  const c = EDGE_COLOUR[kind];
  return (
    <svg className="asyl-swatch" width={40} height={12} viewBox="0 0 40 12" aria-hidden="true">
      {kind === "created" && (
        <line
          x1={2}
          y1={6}
          x2={30}
          y2={6}
          stroke={c}
          strokeWidth={7}
          strokeOpacity={0.3}
          strokeLinecap="round"
        />
      )}
      <line
        x1={1}
        y1={6}
        x2={st.head ? 31 : 39}
        y2={6}
        stroke={c}
        strokeWidth={2.4}
        strokeDasharray={st.dash}
        strokeLinecap={kind === "cotrade" ? "round" : "butt"}
      />
      {st.head && (
        <g transform="translate(30 1)">
          <HeadShape head={st.head} colour={c} />
        </g>
      )}
      {chain && <circle cx={16} cy={6} r={3.2} fill="#120c09" stroke="#fff" strokeWidth={1.5} />}
    </svg>
  );
}

const LEGEND_KEY = "asyl:legend-open";

/** The map's key, in its bottom corner: the links on it, and the marks on its wallets. */
export function MapLegend({ graph, startOpen }: { graph: AsylGraph; startOpen?: boolean }) {
  // Open on a wide screen at first; after that, as the reader last left it.
  const [open, setOpenState] = useState(() => {
    if (startOpen !== undefined) return startOpen;
    try {
      const kept = localStorage.getItem(LEGEND_KEY);
      if (kept !== null) return kept === "1";
    } catch {
      // Storage blocked: the screen's width decides.
    }
    return typeof window === "undefined" || window.innerWidth > 700;
  });
  const setOpen = (f: (o: boolean) => boolean) =>
    setOpenState((o) => {
      const next = f(o);
      try {
        localStorage.setItem(LEGEND_KEY, next ? "1" : "0");
      } catch {
        // Storage blocked: it holds for this visit.
      }
      return next;
    });
  const kinds = EDGE_KINDS.filter((k) => graph.edges.some((e) => e.kind === k));
  const chain = graph.edges.some((e) => e.source === "chain");
  const devs = graph.nodes.some((n) => n.kind === "wallet" && n.tags.includes("dev"));
  if (kinds.length === 0) return null;
  return (
    <div className={`asyl-map-legend${open ? " open" : ""}`}>
      <button className="asyl-map-legend-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Legend {open ? "▾" : "▸"}
      </button>
      {open && (
        <ul>
          {kinds.map((k) => (
            <li key={k}>
              <LinkSwatch kind={k} />
              <b>{EDGE_LABEL[k]}</b>
              <span>{EDGE_STYLE[k].meaning}</span>
            </li>
          ))}
          {chain && (
            <li>
              <LinkSwatch kind="traded" chain />
              <b>Chain read</b>
              <span>A ringed dot: read live from the chain</span>
            </li>
          )}
          {devs && (
            <li>
              <span className="asyl-legend-dev" aria-hidden="true">
                D
              </span>
              <b>Deployer</b>
              <span>A wallet that deployed a coin</span>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/** Cluster tints: warm and cool alternating, so neighbouring groups tell apart on the dark map. */
export const CLUSTER_COLOUR = [
  "#ff7a2f",
  "#4fb6ff",
  "#f2c94c",
  "#c86bff",
  "#36d39a",
  "#ff4f7b",
  "#9ad14b",
  "#ffa0d8",
];

/**
 * What a dragged bubble carries along: neighbours tied to nothing else move with it wholly, its
 * other neighbours half way, so a hub drags its cluster and a shared wallet stretches between two.
 * Bubbles the user placed (pinned) stay put.
 */
export function carriedBy(g: AsylGraph, id: string, pinned: ReadonlySet<string>): Map<string, number> {
  const adj = new Map<string, Set<string>>();
  for (const e of g.edges) {
    if (!adj.has(e.a)) adj.set(e.a, new Set());
    if (!adj.has(e.b)) adj.set(e.b, new Set());
    adj.get(e.a)!.add(e.b);
    adj.get(e.b)!.add(e.a);
  }
  const out = new Map<string, number>();
  for (const n of adj.get(id) ?? []) {
    if (pinned.has(n)) continue;
    out.set(n, (adj.get(n)?.size ?? 0) <= 1 ? 1 : 0.45);
  }
  return out;
}

export function radiusOf(g: AsylGraph): (id: string) => number {
  const degree = new Map<string, number>();
  const held = new Map<string, number>();
  for (const e of g.edges) {
    degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
    degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
    if (e.kind === "holds") held.set(e.a, Math.max(held.get(e.a) ?? 0, e.weight));
  }
  const kind = new Map(g.nodes.map((n) => [n.id, n.kind]));
  return (id) => {
    if (kind.get(id) === "token") return 17;
    const pct = held.get(id);
    if (pct !== undefined) return Math.min(34, 8 + Math.sqrt(pct) * 5);
    return Math.min(26, 9 + Math.sqrt(degree.get(id) ?? 0) * 2.4);
  };
}

/** Line width from an edge's weight, on a log scale within its kind. */
function widthOf(e: AsylEdge, maxByKind: Map<AsylEdgeKind, number>): number {
  const max = maxByKind.get(e.kind) ?? 1;
  const t = max > 0 ? Math.log1p(Math.max(0, e.weight)) / Math.log1p(max) : 0;
  return 1 + t * 3.2;
}

function ringOf(n: AsylNode): string | null {
  if (n.tags.includes("mine")) return "#ffffff";
  if (n.tags.includes("kol") || n.tags.includes("kol-side")) return "#ffd34d";
  if (n.tags.includes("dumper") || n.tags.includes("risky") || n.tags.includes("farm")) return "#ff3b30";
  if (n.tags.includes("winner")) return "#3ee08f";
  if (n.tags.includes("exchange") || n.tags.includes("bot")) return "#9b948f";
  if (n.tags.includes("dev")) return "#ffe066";
  return null;
}

/**
 * Where a node's picture can load from, in order: a coin's thumbnail and its fallbacks (the token
 * cards' own list, format.ts tokenImageSources, Pump.fun's CDN by mint included), a KOL's X picture.
 */
export function imageSources(n: AsylNode): string[] {
  if (n.kind === "token") return tokenImageSources(n.image, 64, n.id);
  return n.avatar ? [avatarUrl(n.avatar)] : [];
}

/** A node's picture, moving to the next source when one fails, and drawing nothing when none loads. */
function NodeImage({ sources, r, tile }: { sources: string[]; r: number; tile: boolean }) {
  const key = sources.join("|");
  const [failed, setFailed] = useState<{ key: string; n: number }>({ key, n: 0 });
  const n = failed.key === key ? failed.n : 0;
  const href = sources[n];
  if (!href) return null;
  return (
    <image
      href={href}
      x={-r + 2}
      y={-r + 2}
      width={r * 2 - 4}
      height={r * 2 - 4}
      clipPath={`url(#asyl-clip-${tile ? "tile" : "circle"})`}
      preserveAspectRatio="xMidYMid slice"
      onError={() => setFailed({ key, n: n + 1 })}
    />
  );
}

export interface View {
  x: number;
  y: number;
  k: number;
}

/** What drawing on the map asks of the page (user ask 2026-10-24). */
export interface DrawHandlers {
  addLine: (a: string, b: string) => void;
  addText: (x: number, y: number) => void;
  select: (id: string | null) => void;
  moveText: (id: string, x: number, y: number) => void;
}

export type DrawTool = "line" | "text" | null;

export interface GraphViewHandle {
  fit: () => void;
  view: () => View;
  size: () => { w: number; h: number };
  /** Draws again, after the page changed the layout's positions itself (an undo). */
  redraw: () => void;
}

export function GraphView({
  graph,
  layout,
  selected,
  focus,
  onSelect,
  onOpen,
  onMoved,
  onMoveStart,
  layoutKey,
  handle,
  readOnly = false,
  timeLabels = DEFAULT_TIME_LABELS,
  drawings,
  tool = null,
  drawingSelected = null,
  onDraw,
  grid = false,
}: {
  graph: AsylGraph;
  layout: LayoutState;
  selected: string | null;
  focus: string | null;
  onSelect: (id: string | null) => void;
  onOpen?: (id: string) => void;
  /** A node was dragged to a new place. */
  onMoved?: () => void;
  /** A bubble is about to move under a drag, so the page can keep where things were. */
  onMoveStart?: () => void;
  /** Changes whenever the map's nodes change, to restart the layout. */
  layoutKey: string;
  handle?: Ref<GraphViewHandle>;
  readOnly?: boolean;
  /** Which kinds of line carry their time along them. */
  timeLabels?: TimeLabels;
  /** The reader's own lines and text boxes, drawn over the map. */
  drawings?: Drawings;
  /** A drawing tool in hand: "line" joins the next two bubbles clicked, "text" places a box. */
  tool?: DrawTool;
  drawingSelected?: string | null;
  onDraw?: DrawHandlers;
  /** Grid mode: every bubble sits on its own cell, sized so names and line times all show. */
  grid?: boolean;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [, setFrame] = useState(0);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [hover, setHover] = useState<{ x: number; y: number; text: string[] } | null>(null);
  // The line tool's first bubble, and where the pointer is, for the line being drawn.
  const [pending, setPending] = useState<string | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (tool !== "line") {
      setPending(null);
      setGhost(null);
    }
  }, [tool]);
  const radius = useMemo(() => radiusOf(graph), [graph]);
  const clusters = useMemo(() => clusterOf(graph), [graph]);
  const maxByKind = useMemo(() => {
    const m = new Map<AsylEdgeKind, number>();
    for (const e of graph.edges) m.set(e.kind, Math.max(m.get(e.kind) ?? 0, e.weight));
    return m;
  }, [graph]);
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const reduceMotion = useMemo(
    () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  const sizeOf = () => {
    const r = svgRef.current?.getBoundingClientRect();
    return { w: r?.width ?? 800, h: r?.height ?? 600 };
  };

  const fit = useCallback(() => {
    const { w, h } = sizeOf();
    const b = bounds(
      layout,
      graph.nodes.map((n) => n.id),
      radius,
    );
    const bw = Math.max(1, b.maxX - b.minX);
    const bh = Math.max(1, b.maxY - b.minY);
    const k = Math.min(2.2, Math.max(0.15, Math.min((w - 80) / bw, (h - 80) / bh)));
    setView({ k, x: w / 2 - ((b.minX + b.maxX) / 2) * k, y: h / 2 - ((b.minY + b.maxY) / 2) * k });
  }, [graph, layout, radius]);

  useImperativeHandle(
    handle,
    () => ({ fit, view: () => viewRef.current, size: sizeOf, redraw: () => setFrame((f) => f + 1) }),
    [fit],
  );

  // The simulation, a step per frame until it settles: after the map changes, and while a bubble
  // is dragged, so what is tied to it follows (user ask 2026-10-24).
  const sim = useRef<{ raf: number; alpha: number; ticks: number }>({ raf: 0, alpha: 0, ticks: 0 });
  const simStarted = useRef(false);
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const radiusRef = useRef(radius);
  radiusRef.current = radius;
  const fitRef = useRef(fit);
  fitRef.current = fit;
  // Grid mode. Bubbles already on the grid hold still while the simulation places new ones, and
  // everything goes onto a free cell once it settles.
  const cell = useMemo(
    () =>
      gridCell(graph, radius, (id) => {
        const n = byId.get(id);
        return n ? nodeName(n) : "";
      }),
    [graph, radius, byId],
  );
  const gridRef = useRef(grid);
  gridRef.current = grid;
  const cellRef = useRef(cell);
  cellRef.current = cell;
  const held = useRef(new Set<string>());
  const gridFitted = useRef(false);
  const snap = useCallback(() => {
    // The first time onto the grid, the free layout is spread to the grid's spacing.
    if (held.current.size === 0) spreadForGrid(layout, graphRef.current, cellRef.current);
    snapToGrid(layout, graphRef.current, cellRef.current);
    held.current = new Set(layout.pos.keys());
  }, [layout]);
  const runSim = useCallback(
    (alpha: number) => {
      const st = sim.current;
      simStarted.current = true;
      st.alpha = Math.max(st.alpha, alpha);
      st.ticks = 0;
      if (st.raf) return;
      const tick = () => {
        const state = gridRef.current
          ? { ...layout, pinned: new Set([...layout.pinned, ...held.current]) }
          : layout;
        const moved = step(state, graphRef.current, st.alpha, radiusRef.current);
        st.alpha = Math.max(0.02, st.alpha * 0.985);
        st.ticks += 1;
        setFrame((f) => f + 1);
        if (!fittedOnce.current && st.ticks === 60) {
          fittedOnce.current = true;
          fitRef.current();
        }
        const dragging = !!drag.current?.moved && !!drag.current.id;
        st.raf = dragging || (moved > 0.08 && st.ticks < 600) ? requestAnimationFrame(tick) : 0;
        if (!st.raf && gridRef.current) {
          snap();
          setFrame((f) => f + 1);
          // The first time the map lands on the grid, frame it there.
          if (!gridFitted.current) {
            gridFitted.current = true;
            fitRef.current();
          }
        }
      };
      st.raf = requestAnimationFrame(tick);
    },
    [layout, snap],
  );
  useEffect(
    () => () => {
      cancelAnimationFrame(sim.current.raf);
      sim.current.raf = 0;
    },
    [],
  );

  // Lay out new nodes, then let the simulation settle them.
  const fittedOnce = useRef(false);
  useEffect(() => {
    const added = placeNew(layout, graph);
    // A saved map opens just as it was left: nothing new, so nothing to settle.
    if (added.length === 0 && !fittedOnce.current && !simStarted.current) {
      if (gridRef.current) snap();
      fittedOnce.current = true;
      setFrame((f) => f + 1);
      fit();
      return;
    }
    // Nothing new to place (links added among what's there, a bubble taken off): everything stays
    // where it is, so a saved or arranged map doesn't drift.
    if (added.length === 0 && fittedOnce.current) {
      setFrame((f) => f + 1);
      return;
    }
    const alpha = added.length > 0 || !fittedOnce.current ? 1 : 0.3;
    // Grid mode settles new bubbles at once, out of sight, and puts them straight onto the grid:
    // no floating about for seconds before they jump to their cells.
    if (gridRef.current) {
      const still = { ...layout, pinned: new Set([...layout.pinned, ...held.current]) };
      for (let t = 0; t < 300; t++) if (step(still, graph, 1 - t / 300, radius) < 0.05 && t > 20) break;
      snap();
      setFrame((f) => f + 1);
      if (!fittedOnce.current) {
        fittedOnce.current = true;
        gridFitted.current = true;
        fit();
      }
      return;
    }
    if (reduceMotion) {
      for (let t = 0; t < 300; t++) if (step(layout, graph, 1 - t / 300, radius) < 0.05 && t > 20) break;
      if (gridRef.current) snap();
      setFrame((f) => f + 1);
      if (!fittedOnce.current) {
        fittedOnce.current = true;
        fit();
      }
      return;
    }
    runSim(alpha);
    // layoutKey stands for the graph's node set; fit and radius follow the graph.
  }, [layoutKey]);

  // Turning grid mode on puts the map on the grid; a new cell size (a longer name, a bigger bubble)
  // spreads the grid out or draws it in, keeping each bubble's place on it.
  const prevCell = useRef<Cell | null>(null);
  useEffect(() => {
    if (!grid) {
      held.current = new Set();
      prevCell.current = null;
      return;
    }
    const was = prevCell.current;
    if (was && (was.w !== cell.w || was.h !== cell.h))
      for (const [id, p] of layout.pos)
        layout.pos.set(id, { x: (p.x * cell.w) / was.w, y: (p.y * cell.h) / was.h });
    prevCell.current = cell;
    // While the simulation runs, it snaps when it settles.
    if (sim.current.raf) return;
    snap();
    setFrame((f) => f + 1);
  }, [grid, cell.w, cell.h]);

  // Pointer handling: pan the background, drag a node, pinch to zoom.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{
    id: string | null;
    moved: boolean;
    startX: number;
    startY: number;
    /** Where on the bubble it was grabbed, so it doesn't jump to the pointer. */
    dx: number;
    dy: number;
    /** What it carries along, and how much: its own leaves wholly, its other neighbours half. */
    carry: Map<string, number>;
    /** A drawing grabbed instead of a bubble: a text box (moved) or a line (picked). */
    drawn?: { id: string; text: boolean };
  } | null>(null);
  const pinch = useRef<{ d: number; k: number } | null>(null);

  const toWorld = (cx: number, cy: number) => {
    const r = svgRef.current!.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (cx - r.left - v.x) / v.k, y: (cy - r.top - v.y) / v.k };
  };

  const onPointerDown = (e: React.PointerEvent, id: string | null) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { d: Math.hypot(a!.x - b!.x, a!.y - b!.y), k: viewRef.current.k };
      drag.current = null;
      return;
    }
    if (tool === "line" && !readOnly && id) {
      // No mouse-down focus change after this: the label editor it opens keeps the cursor.
      e.preventDefault();
      // The line tool: the first bubble, then the second makes the line.
      if (!pending) setPending(id);
      else if (pending !== id) {
        onDraw?.addLine(pending, id);
        setPending(null);
        setGhost(null);
      }
      return;
    }
    if (tool === "line") setPending(null);
    // On a read-only map a node can still be picked; dragging it pans instead of moving it.
    const at = id ? layout.pos.get(id) : undefined;
    const w = at ? toWorld(e.clientX, e.clientY) : null;
    drag.current = {
      id,
      moved: false,
      startX: e.clientX,
      startY: e.clientY,
      dx: at && w ? at.x - w.x : 0,
      dy: at && w ? at.y - w.y : 0,
      // Shift drags the bubble alone.
      carry: id && !e.shiftKey ? carriedBy(graph, id, layout.pinned) : new Map(),
    };
  };

  /** A drawing grabbed: a text box can be dragged; either is picked by a click. */
  const onDrawnDown = (e: React.PointerEvent, id: string, text: boolean) => {
    e.stopPropagation();
    if (readOnly) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const box = text ? drawings?.texts.find((t) => t.id === id) : undefined;
    const w = toWorld(e.clientX, e.clientY);
    drag.current = {
      id: null,
      moved: false,
      startX: e.clientX,
      startY: e.clientY,
      dx: box ? box.x - w.x : 0,
      dy: box ? box.y - w.y : 0,
      carry: new Map(),
      drawn: { id, text },
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (pending) setGhost(toWorld(e.clientX, e.clientY));
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      const r = svgRef.current!.getBoundingClientRect();
      zoomAt((a!.x + b!.x) / 2 - r.left, (a!.y + b!.y) / 2 - r.top, (pinch.current.k * d) / pinch.current.d);
      return;
    }
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > 3) {
      d.moved = true;
      if ((d.id || d.drawn?.text) && !readOnly) onMoveStart?.();
    }
    if (!d.moved) return;
    if (d.drawn) {
      if (d.drawn.text) {
        const w = toWorld(e.clientX, e.clientY);
        onDraw?.moveText(d.drawn.id, w.x + d.dx, w.y + d.dy);
      }
      return;
    }
    if (d.id && !readOnly) {
      const w = toWorld(e.clientX, e.clientY);
      const from = layout.pos.get(d.id) ?? w;
      const to = { x: w.x + d.dx, y: w.y + d.dy };
      for (const [id, share] of d.carry) {
        const p = layout.pos.get(id);
        if (p) layout.pos.set(id, { x: p.x + (to.x - from.x) * share, y: p.y + (to.y - from.y) * share });
      }
      layout.pos.set(d.id, to);
      layout.pinned.add(d.id);
      layout.vel.set(d.id, { x: 0, y: 0 });
      if (!reduceMotion) runSim(0.25);
      setFrame((f) => f + 1);
    } else {
      setView((v) => ({ ...v, x: v.x + e.clientX - prev.x, y: v.y + e.clientY - prev.y }));
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.drawn) {
      if (!d.moved) onDraw?.select(d.drawn.id);
      else onMoved?.();
      return;
    }
    if (!d.moved && !d.id && tool === "text" && !readOnly) {
      const w = toWorld(e.clientX, e.clientY);
      onDraw?.addText(w.x, w.y);
      return;
    }
    if (!d.moved) {
      onDraw?.select(null);
      onSelect(d.id);
    } else if (d.id && !readOnly) {
      if (grid && !sim.current.raf) {
        snap();
        setFrame((f) => f + 1);
      }
      onMoved?.();
    }
  };

  const zoomAt = (px: number, py: number, k: number) => {
    setView((v) => {
      const nk = Math.min(4, Math.max(0.1, k));
      return { k: nk, x: px - ((px - v.x) / v.k) * nk, y: py - ((py - v.y) / v.k) * nk };
    });
  };

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, viewRef.current.k * Math.exp(-e.deltaY * 0.0015));
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

  const showHover = (e: React.PointerEvent, text: string[]) => {
    const r = svgRef.current!.getBoundingClientRect();
    setHover({ x: e.clientX - r.left, y: e.clientY - r.top, text });
  };

  // Neighbours of the selected node stay bright; the rest dim.
  // Bare addresses crowd a big map: past 25 nodes they show only up close, or around the selection.
  const dense = graph.nodes.length / 25;
  const lit = useMemo(() => {
    if (!selected) return null;
    const s = new Set([selected]);
    for (const e of graph.edges) {
      if (e.a === selected) s.add(e.b);
      if (e.b === selected) s.add(e.a);
    }
    return s;
  }, [graph, selected]);

  const markerKinds = EDGE_KINDS.filter((k) => EDGE_STYLE[k].head);

  return (
    <div className="asyl-graph">
      <svg
        ref={svgRef}
        className={`asyl-graph-svg${tool && !readOnly ? ` tool-${tool}` : ""}`}
        role="img"
        aria-label={`Map of ${graph.nodes.length} wallets and coins with ${graph.edges.length} links`}
        onPointerDown={(e) => onPointerDown(e, null)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <defs>
          {markerKinds.map((k) => (
            <marker
              key={k}
              id={`asyl-head-${k}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              markerUnits="userSpaceOnUse"
              orient="auto-start-reverse"
            >
              <HeadShape head={EDGE_STYLE[k].head!} colour={EDGE_COLOUR[k]} />
            </marker>
          ))}
          <clipPath id="asyl-clip-circle" clipPathUnits="objectBoundingBox">
            <circle cx="0.5" cy="0.5" r="0.5" />
          </clipPath>
          <clipPath id="asyl-clip-tile" clipPathUnits="objectBoundingBox">
            <rect x="0" y="0" width="1" height="1" rx="0.22" />
          </clipPath>
        </defs>
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {grid && (
            <>
              <defs>
                <pattern
                  id="asyl-grid"
                  width={cell.w}
                  height={cell.h}
                  x={-cell.w / 2}
                  y={-cell.h / 2}
                  patternUnits="userSpaceOnUse"
                >
                  <path d={`M ${cell.w} 0 L 0 0 0 ${cell.h}`} className="asyl-grid-line" />
                </pattern>
              </defs>
              <rect x={-1e5} y={-1e5} width={2e5} height={2e5} fill="url(#asyl-grid)" pointerEvents="none" />
            </>
          )}
          <g className="asyl-edges">
            {graph.edges.map((e) => {
              const a = layout.pos.get(e.a);
              const b = layout.pos.get(e.b);
              if (!a || !b) return null;
              const ra = radius(e.a);
              const rb = radius(e.b);
              const dx = b.x - a.x;
              const dy = b.y - a.y;
              const d = Math.hypot(dx, dy) || 1;
              // From rim to rim, and bowed a little so two kinds between one pair don't overlap.
              const sx = a.x + (dx / d) * ra;
              const sy = a.y + (dy / d) * ra;
              const ex = b.x - (dx / d) * (rb + 2);
              const ey = b.y - (dy / d) * (rb + 2);
              const bow =
                e.kind === "funded" ? 0 : e.kind === "transfer" ? 0.12 : e.kind === "side" ? -0.12 : 0.06;
              const mx = (sx + ex) / 2 - (dy / d) * d * bow;
              const my = (sy + ey) / 2 + (dx / d) * d * bow;
              const dim = lit && !(lit.has(e.a) && lit.has(e.b));
              const label = [
                `${nodeName(byId.get(e.a)!)} → ${nodeName(byId.get(e.b)!)}`,
                e.label,
                (TIMED_KINDS as readonly string[]).includes(e.kind) ? (edgeTimeFull(e.at) ?? "") : "",
                e.source === "chain" ? "From a chain read" : "",
              ].filter(Boolean);
              const st = EDGE_STYLE[e.kind];
              const key = `${e.kind}|${e.a}|${e.b}|${e.mint ?? ""}`;
              const path = (
                <path
                  key={key}
                  d={`M${sx} ${sy} Q${mx} ${my} ${ex} ${ey}`}
                  fill="none"
                  stroke={EDGE_COLOUR[e.kind]}
                  strokeWidth={widthOf(e, maxByKind) / Math.sqrt(view.k)}
                  strokeOpacity={dim ? 0.12 : e.kind === "holds" ? 0.5 : 0.88}
                  strokeDasharray={st.dash}
                  strokeLinecap={e.kind === "cotrade" ? "round" : undefined}
                  markerEnd={st.head ? `url(#asyl-head-${e.kind})` : undefined}
                  className="asyl-edge"
                  onPointerEnter={(ev) => showHover(ev, label)}
                  onPointerLeave={() => setHover(null)}
                />
              );
              const mid = { x: 0.25 * sx + 0.5 * mx + 0.25 * ex, y: 0.25 * sy + 0.5 * my + 0.25 * ey };
              const z = 1 / Math.sqrt(view.k);
              const deploy = e.kind === "created";
              if (!deploy && e.source !== "chain") return path;
              return (
                <g key={key} opacity={dim ? (deploy ? 0.25 : 0.2) : 1}>
                  {deploy && (
                    // The Deployed line (user ask 2026-10-24: much more its own): a gold glow under
                    // a marching line, and the deployer's D halfway along.
                    <path
                      d={`M${sx} ${sy} Q${mx} ${my} ${ex} ${ey}`}
                      className="asyl-edge-glow"
                      fill="none"
                      stroke={EDGE_COLOUR.created}
                      strokeWidth={9 * z}
                      strokeLinecap="round"
                      pointerEvents="none"
                    />
                  )}
                  {deploy ? (
                    <path
                      d={`M${sx} ${sy} Q${mx} ${my} ${ex} ${ey}`}
                      fill="none"
                      stroke={EDGE_COLOUR.created}
                      strokeWidth={3 * z}
                      strokeDasharray={`${10 * z} ${4 * z}`}
                      markerEnd={`url(#asyl-head-created)`}
                      className="asyl-edge asyl-edge-deploy"
                      onPointerEnter={(ev) => showHover(ev, label)}
                      onPointerLeave={() => setHover(null)}
                    />
                  ) : (
                    path
                  )}
                  {deploy ? (
                    <g transform={`translate(${mid.x} ${mid.y}) scale(${z})`} className="asyl-dev-mark">
                      <circle r={7} />
                      <text y={3.4} textAnchor="middle">
                        D
                      </text>
                    </g>
                  ) : null}
                  {e.source === "chain" && (
                    // A chain read: a ringed dot halfway along, whatever the kind's own pattern.
                    <circle
                      cx={mid.x}
                      cy={mid.y}
                      r={3.4 * z}
                      fill="#120c09"
                      stroke="#fff"
                      strokeWidth={1.5 * z}
                      pointerEvents="none"
                    />
                  )}
                </g>
              );
            })}
          </g>
          <g className="asyl-edge-times" pointerEvents="none">
            {graph.edges.map((e) => {
              // Times along the lines (user ask 2026-10-24): funding and deploys by default,
              // transfers when switched on; as much of the date as the line has room for.
              if (!(TIMED_KINDS as readonly string[]).includes(e.kind) || !timeLabels[e.kind as TimedKind])
                return null;
              const a = layout.pos.get(e.a);
              const b = layout.pos.get(e.b);
              if (!a || !b || !e.at) return null;
              const dx = b.x - a.x;
              const dy = b.y - a.y;
              const d = Math.hypot(dx, dy) || 1;
              const span = (d - radius(e.a) - radius(e.b)) * view.k;
              // About 6px a character at 10.5px, and room left either side for the arrow.
              const text = edgeTimeLabel(e.at, Math.floor((span - 28) / 6));
              if (!text) return null;
              const dim = lit && !(lit.has(e.a) && lit.has(e.b));
              // The line's middle (its bow, as drawn above), and its angle kept upright.
              const bow = e.kind === "funded" ? 0 : e.kind === "transfer" ? 0.12 : 0.06;
              const ra = radius(e.a);
              const rb = radius(e.b) + 2;
              const sx = a.x + (dx / d) * ra;
              const sy = a.y + (dy / d) * ra;
              const ex = b.x - (dx / d) * rb;
              const ey = b.y - (dy / d) * rb;
              const mx = (sx + ex) / 2 - dy * bow;
              const my = (sy + ey) / 2 + dx * bow;
              const x = 0.25 * sx + 0.5 * mx + 0.25 * ex;
              const y = 0.25 * sy + 0.5 * my + 0.25 * ey;
              let angle = (Math.atan2(ey - sy, ex - sx) * 180) / Math.PI;
              if (angle > 90) angle -= 180;
              else if (angle < -90) angle += 180;
              return (
                <g
                  key={`t|${e.kind}|${e.a}|${e.b}|${e.mint ?? ""}`}
                  transform={`translate(${x} ${y}) rotate(${angle}) scale(${1 / view.k})`}
                  opacity={dim ? 0.2 : 1}
                  className="asyl-edge-time"
                >
                  <text y={e.kind === "created" ? -12 : -6} textAnchor="middle" fill={EDGE_COLOUR[e.kind]}>
                    {text}
                  </text>
                </g>
              );
            })}
          </g>
          {drawings && drawings.lines.length > 0 && (
            <g className="asyl-drawn-lines">
              {drawings.lines.map((l) => {
                const a = layout.pos.get(l.a);
                const b = layout.pos.get(l.b);
                if (!a || !b || !byId.has(l.a) || !byId.has(l.b)) return null;
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const d = Math.hypot(dx, dy) || 1;
                const ra = radius(l.a) + 2;
                const rb = radius(l.b) + 2;
                const sx = a.x + (dx / d) * ra;
                const sy = a.y + (dy / d) * ra;
                const ex = b.x - (dx / d) * rb;
                const ey = b.y - (dy / d) * rb;
                // Bowed the other way from the map's own links, so the two never sit on one another.
                const mx = (sx + ex) / 2 + dy * 0.18;
                const my = (sy + ey) / 2 - dx * 0.18;
                const z = 1 / view.k;
                const on = drawingSelected === l.id;
                const path = `M${sx} ${sy} Q${mx} ${my} ${ex} ${ey}`;
                return (
                  <g key={l.id} className={`asyl-drawn-line${on ? " on" : ""}`}>
                    {on && (
                      <path
                        d={path}
                        fill="none"
                        stroke={l.colour}
                        strokeOpacity={0.25}
                        strokeWidth={10 * z}
                      />
                    )}
                    <path
                      d={path}
                      fill="none"
                      stroke={l.colour}
                      strokeWidth={2.6 * z}
                      strokeLinecap="round"
                      pointerEvents="none"
                    />
                    <circle cx={sx} cy={sy} r={3.4 * z} fill={l.colour} pointerEvents="none" />
                    <circle cx={ex} cy={ey} r={3.4 * z} fill={l.colour} pointerEvents="none" />
                    <path
                      d={path}
                      fill="none"
                      stroke="transparent"
                      strokeWidth={14 * z}
                      className="asyl-drawn-hit"
                      onPointerDown={(ev) => onDrawnDown(ev, l.id, false)}
                    />
                  </g>
                );
              })}
            </g>
          )}
          {pending && ghost && layout.pos.get(pending) && (
            <line
              x1={layout.pos.get(pending)!.x}
              y1={layout.pos.get(pending)!.y}
              x2={ghost.x}
              y2={ghost.y}
              stroke="#fff3e6"
              strokeWidth={2 / view.k}
              strokeDasharray={`${6 / view.k} ${5 / view.k}`}
              pointerEvents="none"
            />
          )}
          <g className="asyl-nodes">
            {graph.nodes.map((n) => {
              const p = layout.pos.get(n.id);
              if (!p) return null;
              const r = radius(n.id);
              const dim = lit && !lit.has(n.id);
              const cluster = clusters.get(n.id) ?? -1;
              const fill =
                n.kind === "token"
                  ? "#1a0d08"
                  : cluster >= 0
                    ? CLUSTER_COLOUR[cluster % CLUSTER_COLOUR.length]!
                    : "#3a2116";
              const ring = ringOf(n);
              const isSel = n.id === selected;
              const isFocus = n.id === focus;
              const hoverText = [
                nodeName(n),
                n.kind === "token"
                  ? (n.title ?? "Coin")
                  : n.tags.map((t) => TAG_LABEL[t]).join(" · ") || "Wallet",
                n.risk != null ? `Risk ${n.risk} · Win ${n.win ?? 0}` : "",
              ].filter(Boolean);
              const imgs = imageSources(n);
              return (
                <g
                  key={n.id}
                  className={`asyl-node${isSel ? " selected" : ""}`}
                  transform={`translate(${p.x} ${p.y})`}
                  opacity={dim ? 0.25 : 1}
                  onPointerDown={(e) => onPointerDown(e, n.id)}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    onOpen?.(n.id);
                  }}
                  onPointerEnter={(e) => showHover(e, hoverText)}
                  onPointerLeave={() => setHover(null)}
                >
                  {(isSel || isFocus || n.id === pending) && (
                    <circle
                      r={r + 7}
                      fill="none"
                      stroke="#ffd7a8"
                      strokeWidth={isSel ? 2.5 : 1.5}
                      strokeDasharray={isSel ? undefined : "3 3"}
                    />
                  )}
                  {n.kind === "token" ? (
                    <rect
                      x={-r}
                      y={-r}
                      width={r * 2}
                      height={r * 2}
                      rx={r * 0.44}
                      fill={fill}
                      stroke="#ffb547"
                      strokeWidth={2}
                    />
                  ) : (
                    <circle
                      r={r}
                      fill={fill}
                      fillOpacity={0.9}
                      stroke={ring ?? "#120402"}
                      strokeWidth={ring ? 3 : 1.5}
                    />
                  )}
                  {imgs.length > 0 && <NodeImage sources={imgs} r={r} tile={n.kind === "token"} />}
                  {n.tags.includes("mine") && (
                    <text className="asyl-node-star" y={-r - 4} textAnchor="middle">
                      ★
                    </text>
                  )}
                  {n.kind === "wallet" && n.tags.includes("dev") && (
                    <g className="asyl-dev-mark" transform={`translate(${r * 0.74} ${-r * 0.74})`}>
                      <circle r={6.5} />
                      <text y={3.2} textAnchor="middle">
                        D
                      </text>
                    </g>
                  )}
                  {(isSel || isFocus || (!dim && (n.name || lit || dense < 1 || view.k > 1.1 * dense))) && (
                    <text
                      className="asyl-node-label"
                      y={r + 13}
                      textAnchor="middle"
                      fontSize={11 / Math.min(1.4, Math.max(0.7, view.k))}
                    >
                      {nodeName(n)}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
          {drawings && drawings.lines.some((l) => l.label) && (
            <g className="asyl-drawn-labels">
              {drawings.lines.map((l) => {
                const a = layout.pos.get(l.a);
                const b = layout.pos.get(l.b);
                if (!l.label || !a || !b || !byId.has(l.a) || !byId.has(l.b)) return null;
                // The middle of the line as drawn under the bubbles, its label over them.
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const d = Math.hypot(dx, dy) || 1;
                const ra = radius(l.a) + 2;
                const rb = radius(l.b) + 2;
                const sx = a.x + (dx / d) * ra;
                const sy = a.y + (dy / d) * ra;
                const ex = b.x - (dx / d) * rb;
                const ey = b.y - (dy / d) * rb;
                const midX = 0.25 * sx + 0.5 * ((sx + ex) / 2 + dy * 0.18) + 0.25 * ex;
                const midY = 0.25 * sy + 0.5 * ((sy + ey) / 2 - dx * 0.18) + 0.25 * ey;
                const z = 1 / view.k;
                const on = drawingSelected === l.id;
                return (
                  <g key={l.id}>
                    <g
                      transform={`translate(${midX} ${midY}) scale(${z})`}
                      onPointerDown={(ev) => onDrawnDown(ev, l.id, false)}
                      className="asyl-drawn-label"
                    >
                      <rect
                        x={-(l.label.length * 4.4 + 10)}
                        y={-12}
                        width={l.label.length * 8.8 + 20}
                        height={24}
                        rx={12}
                        fill="#120c09"
                        stroke={l.colour}
                        strokeWidth={on ? 2 : 1.2}
                      />
                      <text y={5} textAnchor="middle" fill={l.colour}>
                        {l.label}
                      </text>
                    </g>
                  </g>
                );
              })}
            </g>
          )}
          {drawings && drawings.texts.length > 0 && (
            <g className="asyl-drawn-texts">
              {drawings.texts.map((t) => {
                const { w, h } = textBoxSize(t.text);
                const on = drawingSelected === t.id;
                return (
                  <g
                    key={t.id}
                    transform={`translate(${t.x} ${t.y})`}
                    className={`asyl-drawn-text${on ? " on" : ""}${readOnly ? "" : " movable"}`}
                    onPointerDown={(ev) => onDrawnDown(ev, t.id, true)}
                  >
                    <rect
                      width={w}
                      height={h}
                      rx={8}
                      fill="rgba(18, 12, 9, 0.92)"
                      stroke={t.colour}
                      strokeWidth={on ? 2 : 1.2}
                      strokeDasharray={on ? "5 3" : undefined}
                    />
                    <text x={12} y={8} fill={t.colour}>
                      {(t.text || "Text").split("\n").map((line, i) => (
                        <tspan key={i} x={12} dy={i === 0 ? 15 : 20}>
                          {line || " "}
                        </tspan>
                      ))}
                    </text>
                  </g>
                );
              })}
            </g>
          )}
        </g>
      </svg>
      {hover && (
        <div className="asyl-tip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
          {hover.text.map((t, i) => (
            <div key={i} className={i === 0 ? "asyl-tip-head" : undefined}>
              {t}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
