import { LinkSwatch } from "./GraphView";
import {
  EDGE_KINDS,
  EDGE_LABEL,
  MONEY_KINDS,
  NO_CUTOFFS,
  TIMED_KINDS,
  clearsCutoffs,
  edgeKey,
  nodeName,
  shortAddr,
  type AsylEdge,
  type AsylEdgeKind,
  type AsylGraph,
  type Cutoffs,
  type TimeLabels,
  type WalletSwitch,
  SWITCH_LABEL,
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
  // Every "bought together" link has 5 coins or more, and buys within 3 minutes (180s).
  shared: [0, 6, 7, 8, 10, 12, 15, 20, 25, 30, 40],
  gap: [0, 120, 90, 60, 45, 30, 20, 15, 10, 5],
  first: [0, 1, 2],
};

/** Who buys first, on a bought-together line: its far end is the co-trader a search found. */
const FIRST: { v: number; label: string; help: string }[] = [
  { v: 0, label: "Either", help: "Every bought-together link" },
  { v: 1, label: "Co-trader first", help: "Wallets that usually bought before the wallet you searched from" },
  { v: 2, label: "Searched first", help: "Wallets that usually bought after the wallet you searched from" },
];

const compact = (n: number) => (n >= 1e6 ? `${n / 1e6}M` : n >= 1e3 ? `${n / 1e3}K` : String(n));

interface SliderSpec {
  key: keyof Cutoffs;
  label: string;
  show: (n: number) => string;
  help: string;
  /** "≥" for a least amount, "≤" for a most. */
  sign?: "≥" | "≤";
}

const SLIDERS: SliderSpec[] = [
  {
    key: "sol",
    label: "SOL",
    show: (n) => `${n} SOL`,
    help: "Funding, SOL transfers and trades; a coin's past holders too",
  },
  {
    key: "usd",
    label: "USD",
    show: (n) => `$${compact(n)}`,
    help: "The same, in dollars at today's SOL price",
  },
  { key: "tokens", label: "Coins", show: (n) => compact(n), help: "Coin transfers read from the chain" },
  {
    key: "pct",
    label: "% supply",
    show: (n) => `${n}%`,
    help: "Holders and holder transfers, as a share of supply",
  },
];

/** The "bought together" sliders (user ask 2026-10-25). */
const TOGETHER: SliderSpec[] = [
  {
    key: "shared",
    label: "Coins in common",
    show: (n) => `${n} coins`,
    help: "Coins both bought within 3 minutes of each other",
  },
  {
    key: "gap",
    label: "Seconds apart",
    show: (n) => (n >= 60 ? `${n / 60} min` : `${n}s`),
    help: "Typical time between their first buys",
    sign: "≤",
  },
];

/**
 * The stop nearest `v` on the slider's own side, so a saved cutoff between stops still lands on
 * it: at or just under for a least amount, at or just over for a most (whose stops run down).
 */
const stopIndex = (stops: number[], v: number) => {
  if (v <= 0) return 0;
  let best = 0;
  for (let i = 1; i < stops.length; i++) {
    const down = stops[i]! < (stops[1] ?? 0);
    if (down ? stops[i]! >= v : stops[i]! <= v) best = i;
  }
  return best;
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
  timeLabels,
  onTimeLabels,
  hideLoose,
  onHideLoose,
  perWallet,
  onClearWallet,
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
  /** Which kinds of line carry their time. */
  timeLabels: TimeLabels;
  onTimeLabels: (t: TimeLabels) => void;
  /** Take off bubbles no drawn link reaches; off by default, so every bubble stays. */
  hideLoose: boolean;
  onHideLoose: (v: boolean) => void;
  /** Kinds switched off for one wallet only, set in the wallet's panel. */
  perWallet: ReadonlyMap<string, ReadonlySet<WalletSwitch>>;
  /** Turns a wallet's own switches back on; null for every wallet. */
  onClearWallet: (wallet: string | null) => void;
}) {
  const names = new Map(graph.nodes.map((n) => [n.id, nodeName(n)]));
  const money = graph.edges.filter((e) => MONEY_KINDS.includes(e.kind));
  const together = graph.edges.filter((e) => e.kind === "cotrade");
  const underCut = money.filter((e) => !clearsCutoffs(e, cutoffs, solUsd)).length;
  const togetherCut = together.filter((e) => !clearsCutoffs(e, cutoffs, solUsd)).length;
  const active = SLIDERS.some((s) => cutoffs[s.key] > 0);
  const togetherActive = TOGETHER.some((s) => cutoffs[s.key] > 0) || cutoffs.first > 0;
  // What a single slider alone hides, so each row says what it is doing.
  const hiddenBy = (key: keyof Cutoffs) =>
    cutoffs[key] > 0
      ? (key === "shared" || key === "gap" || key === "first" ? together : money).filter(
          (e) => !clearsCutoffs(e, { ...NO_CUTOFFS, [key]: cutoffs[key] }, solUsd),
        ).length
      : 0;
  const reset = (specs: SliderSpec[]) =>
    onCutoffs({ ...cutoffs, ...Object.fromEntries(specs.map((sp) => [sp.key, 0])) });
  const slider = (sp: SliderSpec) => {
    const stops = STOPS[sp.key];
    const at = stopIndex(stops, cutoffs[sp.key]);
    const off = sp.key === "usd" && !solUsd;
    const n = hiddenBy(sp.key);
    const sign = sp.sign ?? "≥";
    return (
      <div key={sp.key} className={`asyl-slider${off ? " off" : ""}`}>
        <div className="asyl-slider-head">
          <label htmlFor={`asyl-cut-${sp.key}`}>{sp.label}</label>
          <span className={cutoffs[sp.key] > 0 ? "asyl-slider-val on" : "asyl-slider-val"}>
            {cutoffs[sp.key] > 0 ? `${sign} ${sp.show(cutoffs[sp.key])}` : "Any"}
          </span>
        </div>
        <input
          id={`asyl-cut-${sp.key}`}
          type="range"
          min={0}
          max={stops.length - 1}
          step={1}
          value={at}
          disabled={off}
          style={{ ["--fill" as string]: `${(at / (stops.length - 1)) * 100}%` }}
          onChange={(e) => onCutoffs({ ...cutoffs, [sp.key]: stops[Number(e.target.value)] ?? 0 })}
          aria-valuetext={
            cutoffs[sp.key] > 0
              ? `${sign === "≥" ? "at least" : "at most"} ${sp.show(cutoffs[sp.key])}`
              : "any"
          }
        />
        <div className="asyl-slider-foot">
          {off ? "SOL's price isn't known right now" : sp.help}
          {n > 0 && <span> · {n} hidden</span>}
        </div>
      </div>
    );
  };
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
          Links for single wallets
          {perWallet.size > 0 && (
            <button className="asyl-link asyl-small" onClick={() => onClearWallet(null)}>
              All on
            </button>
          )}
        </h3>
        {perWallet.size === 0 ? (
          <p className="asyl-muted asyl-small">
            Click a wallet, then switch its own kinds of link off in its panel. The switches above are for the
            whole map.
          </p>
        ) : (
          <ul className="asyl-cut-list">
            {[...perWallet].map(([w, kinds]) => (
              <li key={w}>
                <span>
                  <b>{names.get(w) ?? shortAddr(w)}</b>
                  <span className="asyl-muted">
                    {" "}
                    · {[...kinds].map((k) => SWITCH_LABEL[k]).join(", ")} off
                  </span>
                </span>
                <button className="asyl-link asyl-small" onClick={() => onClearWallet(w)}>
                  On
                </button>
              </li>
            ))}
          </ul>
        )}
        <label className={`asyl-loose${hideLoose ? "" : " off"}`}>
          <input
            type="checkbox"
            className="asyl-switch"
            checked={hideLoose}
            onChange={() => onHideLoose(!hideLoose)}
          />
          <span>Hide bubbles left with no link shown</span>
        </label>
        <p className="asyl-muted asyl-small">
          Off, every bubble stays on the map whatever links are switched off; only you take one off.
        </p>
      </section>

      <section className="asyl-rail-card">
        <h3>Times on lines</h3>
        <ul className="asyl-legend">
          {TIMED_KINDS.map((k) => {
            const timed = graph.edges.filter((e) => e.kind === k && e.at).length;
            return (
              <li key={k}>
                <label className={timeLabels[k] ? "" : "off"}>
                  <input
                    type="checkbox"
                    className="asyl-switch"
                    checked={timeLabels[k]}
                    onChange={() => onTimeLabels({ ...timeLabels, [k]: !timeLabels[k] })}
                  />
                  <LinkSwatch kind={k} />
                  <span className="asyl-legend-name">
                    {k === "funded" ? "When funded" : k === "created" ? "When deployed" : "When sent"}
                  </span>
                  {timed > 0 && <span className="asyl-count">{timed}</span>}
                </label>
              </li>
            );
          })}
        </ul>
        <p className="asyl-muted asyl-small">
          In your own time, down to the minute; a short line shows just the day or the time.
        </p>
      </section>

      <section className="asyl-rail-card">
        <h3>
          Smallest amount shown
          {active && (
            <button className="asyl-link asyl-small" onClick={() => reset(SLIDERS)}>
              Reset
            </button>
          )}
        </h3>
        {SLIDERS.map(slider)}
        <p className="asyl-muted asyl-small">
          {money.length === 0
            ? "No funding, transfers or trades on the map yet."
            : underCut > 0
              ? `${money.length - underCut} of ${money.length} money links shown.`
              : `All ${money.length} money links shown.`}{" "}
          Deploys, holdings, side wallets and buying together aren&apos;t cut by amount.
        </p>
      </section>

      <section className="asyl-rail-card">
        <h3>
          Bought together
          {togetherActive && (
            <button
              className="asyl-link asyl-small"
              onClick={() => onCutoffs({ ...cutoffs, shared: 0, gap: 0, first: 0 })}
            >
              Reset
            </button>
          )}
        </h3>
        {TOGETHER.map(slider)}
        <div className="asyl-slider">
          <div className="asyl-slider-head">
            <span>Who buys first</span>
            {hiddenBy("first") > 0 && <span className="asyl-slider-val on">{hiddenBy("first")} hidden</span>}
          </div>
          <div className="asyl-seg" role="radiogroup" aria-label="Who buys first">
            {FIRST.map((f) => (
              <button
                key={f.v}
                role="radio"
                aria-checked={cutoffs.first === f.v}
                className={cutoffs.first === f.v ? "on" : ""}
                title={f.help}
                onClick={() => onCutoffs({ ...cutoffs, first: f.v })}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="asyl-slider-foot">{FIRST.find((f) => f.v === cutoffs.first)?.help}</div>
        </div>
        <p className="asyl-muted asyl-small">
          {together.length === 0
            ? "No bought-together links on the map yet. Wallets that trade like it adds them."
            : togetherCut > 0
              ? `${together.length - togetherCut} of ${together.length} bought-together links shown.`
              : `All ${together.length} bought-together links shown.`}{" "}
          A link needs 5 coins or more both bought within 3 minutes of each other.
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
