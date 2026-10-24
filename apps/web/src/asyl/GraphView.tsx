import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import {
  clusterOf,
  DIRECTED,
  nodeName,
  TAG_LABEL,
  type AsylEdge,
  type AsylEdgeKind,
  type AsylGraph,
  type AsylNode,
} from "./graph";
import { bounds, placeNew, step, type LayoutState } from "./layout";
import { avatarUrl } from "./asylApi";

/**
 * The map: every node a bubble (a wallet) or a tile (a coin), every link a line coloured by its
 * kind, with an arrow where it has a direction. Drag the background to pan, the wheel or a pinch
 * to zoom, drag a bubble to move it (it stays where it is put), click to select, double-click to
 * open what it is tied to. Laid out by layout.ts, a step per frame until it settles.
 */

export const EDGE_COLOUR: Record<AsylEdgeKind, string> = {
  funded: "#ffb547",
  transfer: "#ff5533",
  side: "#e38cff",
  cotrade: "#6fd6c4",
  created: "#ffe066",
  traded: "#79a8ff",
  holds: "#8f8a86",
};

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

export interface View {
  x: number;
  y: number;
  k: number;
}

export interface GraphViewHandle {
  fit: () => void;
  view: () => View;
  size: () => { w: number; h: number };
}

export function GraphView({
  graph,
  layout,
  selected,
  focus,
  onSelect,
  onOpen,
  onMoved,
  layoutKey,
  handle,
  readOnly = false,
}: {
  graph: AsylGraph;
  layout: LayoutState;
  selected: string | null;
  focus: string | null;
  onSelect: (id: string | null) => void;
  onOpen?: (id: string) => void;
  /** A node was dragged to a new place. */
  onMoved?: () => void;
  /** Changes whenever the map's nodes change, to restart the layout. */
  layoutKey: string;
  handle?: Ref<GraphViewHandle>;
  readOnly?: boolean;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [, setFrame] = useState(0);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [hover, setHover] = useState<{ x: number; y: number; text: string[] } | null>(null);
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

  useImperativeHandle(handle, () => ({ fit, view: () => viewRef.current, size: sizeOf }), [fit]);

  // Lay out new nodes, then run the simulation a step per frame until it settles.
  const fittedOnce = useRef(false);
  useEffect(() => {
    const added = placeNew(layout, graph);
    let alpha = added.length > 0 || !fittedOnce.current ? 1 : 0.3;
    let raf = 0;
    let ticks = 0;
    if (reduceMotion) {
      for (let t = 0; t < 300; t++) if (step(layout, graph, 1 - t / 300, radius) < 0.05 && t > 20) break;
      setFrame((f) => f + 1);
      if (!fittedOnce.current) {
        fittedOnce.current = true;
        fit();
      }
      return;
    }
    const tick = () => {
      const moved = step(layout, graph, alpha, radius);
      alpha = Math.max(0.02, alpha * 0.985);
      ticks += 1;
      setFrame((f) => f + 1);
      if (!fittedOnce.current && ticks === 60) {
        fittedOnce.current = true;
        fit();
      }
      if (moved > 0.08 && ticks < 600) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // layoutKey stands for the graph's node set; fit and radius follow the graph.
  }, [layoutKey]);

  // Pointer handling: pan the background, drag a node, pinch to zoom.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ id: string | null; moved: boolean; startX: number; startY: number } | null>(null);
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
    // On a read-only map a node can still be picked; dragging it pans instead of moving it.
    drag.current = { id, moved: false, startX: e.clientX, startY: e.clientY };
  };

  const onPointerMove = (e: React.PointerEvent) => {
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
    if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > 3) d.moved = true;
    if (!d.moved) return;
    if (d.id && !readOnly) {
      const w = toWorld(e.clientX, e.clientY);
      layout.pos.set(d.id, w);
      layout.pinned.add(d.id);
      layout.vel.set(d.id, { x: 0, y: 0 });
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
    if (!d.moved) onSelect(d.id);
    else if (d.id && !readOnly) onMoved?.();
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
  const lit = useMemo(() => {
    if (!selected) return null;
    const s = new Set([selected]);
    for (const e of graph.edges) {
      if (e.a === selected) s.add(e.b);
      if (e.b === selected) s.add(e.a);
    }
    return s;
  }, [graph, selected]);

  const markerKinds = [...DIRECTED];

  return (
    <div className="asyl-graph">
      <svg
        ref={svgRef}
        className="asyl-graph-svg"
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
              id={`asyl-arrow-${k}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0 0 L10 5 L0 10 z" fill={EDGE_COLOUR[k]} />
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
                e.source === "chain" ? "From a chain read" : "",
              ].filter(Boolean);
              return (
                <path
                  key={`${e.kind}|${e.a}|${e.b}|${e.mint ?? ""}`}
                  d={`M${sx} ${sy} Q${mx} ${my} ${ex} ${ey}`}
                  fill="none"
                  stroke={EDGE_COLOUR[e.kind]}
                  strokeWidth={widthOf(e, maxByKind) / Math.sqrt(view.k)}
                  strokeOpacity={dim ? 0.12 : e.kind === "holds" ? 0.45 : 0.85}
                  strokeDasharray={e.source === "chain" ? "6 4" : e.kind === "cotrade" ? "2 4" : undefined}
                  markerEnd={DIRECTED.has(e.kind) ? `url(#asyl-arrow-${e.kind})` : undefined}
                  className="asyl-edge"
                  onPointerEnter={(ev) => showHover(ev, label)}
                  onPointerLeave={() => setHover(null)}
                />
              );
            })}
          </g>
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
              const img = n.kind === "token" ? n.image : n.avatar ? avatarUrl(n.avatar) : null;
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
                  {(isSel || isFocus) && (
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
                  {img && (
                    <image
                      href={img}
                      x={-r + 2}
                      y={-r + 2}
                      width={r * 2 - 4}
                      height={r * 2 - 4}
                      clipPath={`url(#asyl-clip-${n.kind === "token" ? "tile" : "circle"})`}
                      preserveAspectRatio="xMidYMid slice"
                    />
                  )}
                  {n.tags.includes("mine") && (
                    <text className="asyl-node-star" y={-r - 4} textAnchor="middle">
                      ★
                    </text>
                  )}
                  {(view.k > 0.55 || isSel || isFocus || n.name) && (
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
