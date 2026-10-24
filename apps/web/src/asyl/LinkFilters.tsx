import { LinkSwatch } from "./GraphView";
import {
  EDGE_KINDS,
  EDGE_LABEL,
  MONEY_KINDS,
  NO_CUTOFFS,
  clearsCutoffs,
  edgeKey,
  nodeName,
  shortAddr,
  type AsylEdge,
  type AsylEdgeKind,
  type AsylGraph,
  type Cutoffs,
} from "./graph";

/**
 * The rail's Links tab (user ask 2026-10-24): which kinds of link are drawn, the least SOL, USD,
 * coins or % of supply a money link must carry to be drawn, and the links hidden one by one. The
 * map redraws as a slider moves; what a later read adds is held to the same cutoffs.
 */

/** Each slider's stops: dense at the small end, where most funding and transfers sit. */
const STOPS: Record<keyof Cutoffs, number[]> = {
  sol: [0, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000],
  usd: [0, 1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000],
  tokens: [0, 1_000, 10_000, 50_000, 100_000, 500_000, 1e6, 5e6, 1e7, 5e7, 1e8],
  pct: [0, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
};

const compact = (n: number) => (n >= 1e6 ? `${n / 1e6}M` : n >= 1e3 ? `${n / 1e3}K` : String(n));

const SLIDERS: { key: keyof Cutoffs; label: string; show: (n: number) => string; help: string }[] = [
  { key: "sol", label: "SOL", show: (n) => `${n} SOL`, help: "Funding, SOL transfers and trades" },
  {
    key: "usd",
    label: "USD",
    show: (n) => `$${compact(n)}`,
    help: "The same, in dollars at today's SOL price",
  },
  { key: "tokens", label: "Coins", show: (n) => compact(n), help: "Coin transfers read from the chain" },
  { key: "pct", label: "% supply", show: (n) => `${n}%`, help: "Holder transfers, as a share of supply" },
];

/** The stop at or just under `v`, so a saved cutoff between stops still lands on the slider. */
const stopIndex = (stops: number[], v: number) => {
  let i = 0;
  while (i + 1 < stops.length && stops[i + 1]! <= v) i++;
  return i;
};

export function LinkFilters({
  graph,
  hiddenKinds,
  onToggleKind,
  cutoffs,
  onCutoffs,
  solUsd,
  cut,
  onRestore,
}: {
  /** Everything on the map, before any filter. */
  graph: AsylGraph;
  hiddenKinds: ReadonlySet<AsylEdgeKind>;
  onToggleKind: (k: AsylEdgeKind) => void;
  cutoffs: Cutoffs;
  onCutoffs: (c: Cutoffs) => void;
  solUsd: number | null;
  /** Links hidden one by one, by edgeKey. */
  cut: ReadonlySet<string>;
  onRestore: (keys: string[]) => void;
}) {
  const names = new Map(graph.nodes.map((n) => [n.id, nodeName(n)]));
  const money = graph.edges.filter((e) => MONEY_KINDS.includes(e.kind));
  const underCut = money.filter((e) => !clearsCutoffs(e, cutoffs, solUsd)).length;
  const active = SLIDERS.some((s) => cutoffs[s.key] > 0);
  // What a single slider alone hides, so each row says what it is doing.
  const hiddenBy = (key: keyof Cutoffs) =>
    cutoffs[key] > 0
      ? money.filter((e) => !clearsCutoffs(e, { ...NO_CUTOFFS, [key]: cutoffs[key] }, solUsd)).length
      : 0;
  const cutEdges = graph.edges.filter((e) => cut.has(edgeKey(e)));
  const name = (id: string) => names.get(id) ?? shortAddr(id);

  return (
    <>
      <section className="asyl-rail-card">
        <h3>Kinds of link</h3>
        <ul className="asyl-legend">
          {EDGE_KINDS.map((k) => {
            const count = graph.edges.filter((e) => e.kind === k).length;
            const on = !hiddenKinds.has(k);
            return (
              <li key={k}>
                <label className={on ? "" : "off"}>
                  <input
                    type="checkbox"
                    className="asyl-switch"
                    checked={on}
                    onChange={() => onToggleKind(k)}
                  />
                  <LinkSwatch kind={k} />
                  <span className="asyl-legend-name">{EDGE_LABEL[k]}</span>
                  {count > 0 && <span className="asyl-count">{count}</span>}
                </label>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="asyl-rail-card">
        <h3>
          Smallest amount shown
          {active && (
            <button className="asyl-link asyl-small" onClick={() => onCutoffs(NO_CUTOFFS)}>
              Reset
            </button>
          )}
        </h3>
        {SLIDERS.map((s) => {
          const stops = STOPS[s.key];
          const at = stopIndex(stops, cutoffs[s.key]);
          const off = s.key === "usd" && !solUsd;
          const n = hiddenBy(s.key);
          return (
            <div key={s.key} className={`asyl-slider${off ? " off" : ""}`}>
              <div className="asyl-slider-head">
                <label htmlFor={`asyl-cut-${s.key}`}>{s.label}</label>
                <span className={cutoffs[s.key] > 0 ? "asyl-slider-val on" : "asyl-slider-val"}>
                  {cutoffs[s.key] > 0 ? `≥ ${s.show(cutoffs[s.key])}` : "Any"}
                </span>
              </div>
              <input
                id={`asyl-cut-${s.key}`}
                type="range"
                min={0}
                max={stops.length - 1}
                step={1}
                value={at}
                disabled={off}
                style={{ ["--fill" as string]: `${(at / (stops.length - 1)) * 100}%` }}
                onChange={(e) => onCutoffs({ ...cutoffs, [s.key]: stops[Number(e.target.value)] ?? 0 })}
                aria-valuetext={cutoffs[s.key] > 0 ? `at least ${s.show(cutoffs[s.key])}` : "any amount"}
              />
              <div className="asyl-slider-foot">
                {off ? "SOL's price isn't known right now" : s.help}
                {n > 0 && <span> · {n} hidden</span>}
              </div>
            </div>
          );
        })}
        <p className="asyl-muted asyl-small">
          {money.length === 0
            ? "No funding, transfers or trades on the map yet."
            : underCut > 0
              ? `${money.length - underCut} of ${money.length} money links shown.`
              : `All ${money.length} money links shown.`}{" "}
          Deploys, holdings, side wallets and buying together aren&apos;t cut by amount.
        </p>
      </section>

      {cutEdges.length > 0 && (
        <section className="asyl-rail-card">
          <h3>
            Hidden links ({cutEdges.length})
            <button className="asyl-link asyl-small" onClick={() => onRestore(cutEdges.map(edgeKey))}>
              Show all
            </button>
          </h3>
          <ul className="asyl-cut-list">
            {cutEdges.map((e: AsylEdge) => (
              <li key={edgeKey(e)}>
                <LinkSwatch kind={e.kind} />
                <span className="asyl-cut-what" title={e.label}>
                  {name(e.a)} → {name(e.b)}
                </span>
                <button
                  className="asyl-icon-btn"
                  title="Show this link again"
                  aria-label={`Show the ${EDGE_LABEL[e.kind]} link again`}
                  onClick={() => onRestore([edgeKey(e)])}
                >
                  ↺
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
