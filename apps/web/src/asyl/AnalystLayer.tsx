import { useState } from "react";
import {
  ANALYST,
  analystView,
  boxColour,
  boxesOf,
  captionColour,
  familiesOf,
  linkStyle,
  type AnalystScene,
} from "./analyst";
import type { AsylGraph, AsylNode } from "./graph";

/**
 * Analyst Mode on screen: the flowchart analyst.ts lays out, drawn in map units so it zooms as one
 * picture. Lines and frames go under the boxes; the boxes take the same pointer handling as the
 * bubbles do.
 */

type Point = { x: number; y: number };

export function AnalystDefs() {
  return (
    <>
      {(["ink", "dev"] as const).map((k) => (
        <marker
          key={k}
          id={`asyl-a-head-${k}`}
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="9"
          markerHeight="9"
          markerUnits="userSpaceOnUse"
          orient="auto-start-reverse"
        >
          <path d="M0 0.5 L10 5 L0 9.5 L2.6 5 z" fill={ANALYST[k]} />
        </marker>
      ))}
    </>
  );
}

const pathOf = (pts: [number, number][]) => pts.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join(" ");

export function AnalystLinks({
  scene,
  lit,
  onHover,
  onLeave,
}: {
  scene: AnalystScene;
  lit: ReadonlySet<string> | null;
  onHover: (e: React.PointerEvent, text: string[]) => void;
  onLeave: () => void;
}) {
  return (
    <g className="asyl-a-links" fontFamily={ANALYST.font}>
      <rect x={-1e5} y={-1e5} width={2e5} height={2e5} fill={ANALYST.page} pointerEvents="none" />
      {scene.frames.map((f) => (
        <rect
          key={f.ids.join("|")}
          x={f.x}
          y={f.y}
          width={f.w}
          height={f.h}
          fill="none"
          stroke={ANALYST.ink}
          strokeWidth={2}
          strokeDasharray="8 6"
          opacity={lit && !f.ids.some((id) => lit.has(id)) ? 0.25 : 0.85}
          pointerEvents="none"
        />
      ))}
      {scene.routes.map((r) => {
        const e = r.edge;
        const dim = lit && !(lit.has(e.a) && lit.has(e.b));
        const { colour, dash, arrow } = linkStyle(e);
        const d = pathOf(r.points);
        return (
          <g
            key={`${e.kind}|${e.a}|${e.b}|${e.mint ?? ""}`}
            opacity={dim ? 0.15 : 1}
            onPointerEnter={(ev) => onHover(ev, [r.text, e.label].filter(Boolean))}
            onPointerLeave={onLeave}
          >
            <path d={d} fill="none" stroke="transparent" strokeWidth={10} />
            <path
              d={d}
              fill="none"
              stroke={colour}
              strokeWidth={1.8}
              strokeDasharray={dash ?? undefined}
              strokeLinejoin="miter"
              markerEnd={arrow ? `url(#asyl-a-head-${e.kind === "created" ? "dev" : "ink"})` : undefined}
            />
          </g>
        );
      })}
      <g pointerEvents="none">
        {scene.routes.map((r) => {
          const e = r.edge;
          const dim = lit && !(lit.has(e.a) && lit.has(e.b));
          return (
            <text
              key={`${e.kind}|${e.a}|${e.b}|${e.mint ?? ""}`}
              x={r.tx}
              y={r.ty}
              textAnchor={r.anchor}
              fontSize={11.5}
              fill={ANALYST.ink}
              stroke={ANALYST.page}
              strokeWidth={4}
              paintOrder="stroke"
              opacity={dim ? 0.15 : 0.95}
            >
              {r.text}
            </text>
          );
        })}
      </g>
    </g>
  );
}

function BoxImage({
  sources,
  x,
  y,
  s,
  round,
}: {
  sources: string[];
  x: number;
  y: number;
  s: number;
  round: boolean;
}) {
  const key = sources.join("|");
  const [failed, setFailed] = useState<{ key: string; n: number }>({ key, n: 0 });
  const n = failed.key === key ? failed.n : 0;
  const href = sources[n];
  if (!href) return null;
  return (
    <image
      href={href}
      x={x}
      y={y}
      width={s}
      height={s}
      clipPath={`url(#asyl-clip-${round ? "circle" : "tile"})`}
      preserveAspectRatio="xMidYMid slice"
      onError={() => setFailed({ key, n: n + 1 })}
    />
  );
}

export function AnalystNodes({
  scene,
  pos,
  byId,
  selected,
  picked,
  pending,
  lit,
  images,
  onDown,
  onOpen,
  onHover,
  onLeave,
}: {
  scene: AnalystScene;
  pos: ReadonlyMap<string, Point>;
  byId: ReadonlyMap<string, AsylNode>;
  selected: string | null;
  picked?: ReadonlySet<string>;
  pending: string | null;
  lit: ReadonlySet<string> | null;
  images: (n: AsylNode) => string[];
  onDown: (e: React.PointerEvent, id: string) => void;
  onOpen?: (id: string) => void;
  onHover: (e: React.PointerEvent, text: string[]) => void;
  onLeave: () => void;
}) {
  return (
    <g className="asyl-a-nodes" fontFamily={ANALYST.font}>
      {[...scene.boxes.values()].map((b) => {
        const p = pos.get(b.id);
        const n = byId.get(b.id);
        if (!p || !n) return null;
        const dim = lit && !lit.has(b.id);
        const colour = boxColour(b);
        const isPicked = !!picked?.has(b.id);
        const members = scene.view.groups.get(b.id);
        const hover = [
          n.name ?? b.id,
          members
            ? `${members.length} wallets folded in: on this map they only traded or hold this coin`
            : n.kind === "token"
              ? (n.title ?? "Coin")
              : b.id,
        ];
        const imgs = b.role === "service" ? [] : images(n);
        const service = b.role === "service";
        return (
          <g
            key={b.id}
            className={`asyl-node asyl-a-node${b.id === selected ? " selected" : ""}${isPicked ? " picked" : ""}`}
            transform={`translate(${p.x} ${p.y})`}
            opacity={dim ? 0.25 : 1}
            onPointerDown={(e) => onDown(e, b.id)}
            onDoubleClick={(e) => {
              e.stopPropagation();
              onOpen?.(b.id);
            }}
            onPointerEnter={(e) => onHover(e, hover)}
            onPointerLeave={onLeave}
          >
            {isPicked &&
              (service ? (
                <circle r={b.w / 2 + 6} className="asyl-pick-ring" />
              ) : (
                <rect
                  x={-b.w / 2 - 6}
                  y={-b.h / 2 - 6}
                  width={b.w + 12}
                  height={b.h + 12}
                  className="asyl-pick-ring"
                />
              ))}
            {(b.id === selected || b.id === pending) &&
              (service ? (
                <circle r={b.w / 2 + 5} fill="none" stroke={ANALYST.select} strokeWidth={2.5} />
              ) : (
                <rect
                  x={-b.w / 2 - 5}
                  y={-b.h / 2 - 5}
                  width={b.w + 10}
                  height={b.h + 10}
                  fill="none"
                  stroke={ANALYST.select}
                  strokeWidth={2.5}
                  strokeDasharray={b.id === selected ? undefined : "4 3"}
                />
              ))}
            {service ? (
              <>
                <circle r={b.w / 2} fill={ANALYST.page} stroke={ANALYST.ink} strokeWidth={2} />
                <text y={5} textAnchor="middle" fontSize={14} fill={ANALYST.ink}>
                  S
                </text>
              </>
            ) : (
              <>
                <rect
                  x={-b.w / 2}
                  y={-b.h / 2}
                  width={b.w}
                  height={b.h}
                  fill={ANALYST.page}
                  stroke={colour}
                  strokeWidth={b.focus ? 3 : 2.4}
                />
                {imgs.length > 0 && (
                  <BoxImage
                    sources={imgs}
                    x={b.w / 2 - b.h + 6}
                    y={-b.h / 2 + 6}
                    s={b.h - 12}
                    round={n.kind === "wallet"}
                  />
                )}
                {b.lines.map((line, i) => (
                  <text
                    key={i}
                    x={imgs.length && b.lines.length === 1 ? -(b.h - 12) / 2 : 0}
                    y={(i - (b.lines.length - 1) / 2) * 17 + (b.lines.length === 1 ? 5.5 : 4.5)}
                    textAnchor="middle"
                    fontSize={b.lines.length === 1 ? 16 : 13}
                    letterSpacing={b.lines.length === 1 ? 0.6 : 0.2}
                    fill={b.role === "group" ? ANALYST.group : ANALYST.ink}
                  >
                    {line}
                  </text>
                ))}
              </>
            )}
            {b.caption && (
              <text
                y={service ? b.h / 2 + 15 : -b.h / 2 - 9}
                textAnchor="middle"
                fontSize={service ? 11 : 13.5}
                fill={captionColour(b)}
                stroke={ANALYST.page}
                strokeWidth={4}
                paintOrder="stroke"
                pointerEvents="none"
              >
                {b.caption.length > 26 ? `${b.caption.slice(0, 25)}…` : b.caption}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}

const LEGEND_KEY = "asyl:analyst-legend-open";

/** Analyst Mode's key, as the flowchart reads. */
export function AnalystLegend({ graph, focus }: { graph: AsylGraph; focus: string | null }) {
  const [open, setOpenState] = useState(() => {
    if (typeof window !== "undefined" && window.innerWidth <= 700) return false;
    try {
      return localStorage.getItem(LEGEND_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const toggle = () =>
    setOpenState((o) => {
      try {
        localStorage.setItem(LEGEND_KEY, o ? "0" : "1");
      } catch {
        // Storage blocked: it holds for this visit.
      }
      return !o;
    });
  const view = analystView(graph, focus);
  const boxes = boxesOf(view, focus);
  const has = (pred: (k: string) => boolean) => view.graph.edges.some((e) => pred(e.kind));
  const roles = new Set([...boxes.values()].map((b) => b.role));
  const rows: { mark: React.ReactNode; text: string }[] = [];
  const swatch = (stroke: string, dash?: string, arrow = true) => (
    <svg width={34} height={12} viewBox="0 0 34 12" aria-hidden="true">
      <line
        x1={1}
        y1={6}
        x2={arrow ? 26 : 33}
        y2={6}
        stroke={stroke}
        strokeWidth={2}
        strokeDasharray={dash}
      />
      {arrow && <path d="M25 1 L33 6 L25 11 L27 6 z" fill={stroke} />}
    </svg>
  );
  const box = (stroke: string) => (
    <svg width={34} height={16} viewBox="0 0 34 16" aria-hidden="true">
      <rect x={2} y={2} width={30} height={12} fill="none" stroke={stroke} strokeWidth={2.2} />
    </svg>
  );
  if (roles.has("group")) rows.push({ mark: box(ANALYST.group), text: "Trader groups" });
  if (roles.has("dev")) rows.push({ mark: box(ANALYST.dev), text: "Dev wallets" });
  if ([...boxes.values()].some((b) => b.focus))
    rows.push({ mark: box(ANALYST.focus), text: "The map's wallet" });
  if (has((k) => k === "funded" || k === "transfer"))
    rows.push({ mark: swatch(ANALYST.ink), text: "Funding and transfers" });
  if (has((k) => k === "created")) rows.push({ mark: swatch(ANALYST.dev), text: "Deployed" });
  if (has((k) => k === "traded" || k === "holds"))
    rows.push({ mark: swatch(ANALYST.group, undefined, false), text: "Traded or holds" });
  if (has((k) => k === "cotrade"))
    rows.push({ mark: swatch(ANALYST.ink, "5 4", false), text: "Time/size connection" });
  if (roles.has("service"))
    rows.push({
      mark: (
        <svg width={34} height={18} viewBox="0 0 34 18" aria-hidden="true">
          <circle cx={17} cy={9} r={8} fill="none" stroke={ANALYST.ink} strokeWidth={1.6} />
          <text
            x={17}
            y={12.5}
            textAnchor="middle"
            fontSize={11}
            fill={ANALYST.ink}
            fontFamily={ANALYST.font}
          >
            S
          </text>
        </svg>
      ),
      text: "Service/Exchange",
    });
  if (familiesOf(view.graph).size)
    rows.push({
      mark: (
        <svg width={34} height={18} viewBox="0 0 34 18" aria-hidden="true">
          <rect
            x={4}
            y={2}
            width={26}
            height={14}
            fill="none"
            stroke={ANALYST.ink}
            strokeWidth={1.6}
            strokeDasharray="4 3"
          />
        </svg>
      ),
      text: "Grouped wallets",
    });
  if (!rows.length) return null;
  return (
    <div className={`asyl-map-legend asyl-a-legend${open ? " open" : ""}`}>
      <button className="asyl-map-legend-toggle" aria-expanded={open} onClick={toggle}>
        Legend {open ? "▾" : "▸"}
      </button>
      {open && (
        <ul>
          {rows.map((r) => (
            <li key={r.text}>
              {r.mark}
              <b>{r.text}</b>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
