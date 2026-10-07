import { useEffect, useRef, useState } from "react";
import type { LighthouseCount, LighthouseTally, MarketLighthouse } from "../api";
import { usePolling } from "../hooks";
import { ago, pct } from "../format";
import { HBarChart, Skeleton } from "./Charts";
import { ArrowRightIcon, CloseIcon, LighthouseIcon } from "./Icons";

/**
 * The Market Lighthouse: what TokenSage sees across the new coins the scanner reads - which
 * narratives are rising, where their stories come from, what gets flagged - and how the models'
 * calls did by narrative. Aggregates only (see the API's marketLighthouse.ts), so guests read
 * the same answer as subscribers without seeing any live coin early.
 *
 * Colors: the tide and the mix share one mapping, the categorical slots --series-1..5 in fixed
 * order for the biggest narratives, then a neutral "other". Every chart names its series in a
 * legend or a label beside the mark, never color alone.
 */

const WINDOWS = [1, 7] as const;
type Days = (typeof WINDOWS)[number];

/** Graded alerts below which a narrative's hit rate shows as early rather than as a verdict. */
const MIN_GRADED = 5;

const path = (base: string, days: number) => `${base}/lighthouse?days=${days}`;

/** TokenSage's codes ("x_link_reused", "about_this_coin") as words. */
export const words = (code: string) => code.replace(/[_-]+/g, " ").trim();

const share = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : null);

/** Series class for a label: the tide's order decides it, so the mix and the tide agree. */
function seriesClassFor(order: string[]) {
  return (label: string) => {
    const i = order.indexOf(label);
    return label === "other" || i < 0 ? "lh-other" : `lh-s${i + 1}`;
  };
}

/**
 * The strip near the top of the Models tab: today's reads and the leading narrative, opening the
 * full Lighthouse. It reads the same 1-day answer the modal opens on.
 */
export function MarketLighthouseStrip({ base, target2xPct }: { base: string; target2xPct: number }) {
  const [open, setOpen] = useState(false);
  const q = usePolling<MarketLighthouse>(path(base, 1), 300_000);
  const d = q.data;
  const totals = d
    ? d.tide.series.map((s) => ({ label: s.label, n: s.values.reduce((a, b) => a + b, 0) }))
    : [];
  const described = totals.reduce((s, t) => s + t.n, 0);
  const lead = totals.filter((t) => t.label !== "other").sort((a, b) => b.n - a.n)[0];
  const spark = d
    ? d.tide.buckets.map((_, i) => d.tide.series.reduce((s, x) => s + (x.values[i] ?? 0), 0))
    : [];
  const sparkMax = Math.max(1, ...spark);

  return (
    <>
      <button
        type="button"
        className="panel lh-strip"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label="Open the Market Lighthouse"
      >
        <span className="lh-strip-icon" aria-hidden>
          <LighthouseIcon size={20} />
        </span>
        <span className="lh-strip-text">
          <span className="lh-strip-title">
            Market Lighthouse
            {d && (
              <span className={`lh-pill ${d.tokenSage.on ? "on" : "off"}`}>
                <span className="lh-pill-dot" aria-hidden />
                {d.tokenSage.on ? "TokenSage live" : "TokenSage off"}
              </span>
            )}
          </span>
          <span className="muted small">
            {!d ? (
              q.error ? (
                "What TokenSage sees across new coins"
              ) : (
                "Reading the market…"
              )
            ) : d.reads.total === 0 ? (
              d.tokenSage.on ? (
                "TokenSage is on; its first reads of the day will show here."
              ) : (
                "What TokenSage sees across new coins, once it is switched on."
              )
            ) : (
              <>
                <strong className="num">{d.reads.described.toLocaleString()}</strong> coins read in the last
                24h
                {lead && described > 0 ? (
                  <>
                    {" "}
                    · leading narrative <strong>{words(lead.label)}</strong> ({pct(share(lead.n, described))})
                  </>
                ) : null}
              </>
            )}
          </span>
        </span>
        {spark.length > 1 && spark.some((v) => v > 0) && (
          <span className="lh-spark" aria-hidden>
            {spark.map((v, i) => (
              <span key={i} style={{ height: `${Math.max(4, (v / sparkMax) * 100)}%` }} />
            ))}
          </span>
        )}
        <span className="lh-strip-cta">
          Open <ArrowRightIcon size={14} />
        </span>
      </button>
      <MarketLighthouseModal
        open={open}
        onClose={() => setOpen(false)}
        base={base}
        target2xPct={target2xPct}
      />
    </>
  );
}

export function MarketLighthouseModal({
  open,
  onClose,
  base,
  target2xPct,
}: {
  open: boolean;
  onClose: () => void;
  base: string;
  target2xPct: number;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [days, setDays] = useState<Days>(1);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="about-modal sheet-modal lh-modal"
      aria-labelledby="lh-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="about-body lh-body">
        <header className="lh-head">
          <div className="lh-beam" aria-hidden />
          <div className="lh-head-row">
            <span className="lh-head-icon" aria-hidden>
              <LighthouseIcon size={22} />
            </span>
            <div className="lh-head-text">
              <h2 id="lh-title">Market Lighthouse</h2>
              <p className="muted small">
                What TokenSage sees across the new coins the scanner reads, and which narratives the
                models&apos; calls win on.
              </p>
            </div>
            <button className="ghost icon-btn" onClick={onClose} aria-label="Close">
              <CloseIcon size={16} />
            </button>
          </div>
          <div className="segmented lh-window" role="tablist" aria-label="Window">
            {WINDOWS.map((w) => (
              <button
                key={w}
                role="tab"
                aria-selected={w === days}
                className={w === days ? "on" : ""}
                onClick={() => setDays(w)}
              >
                {w === 1 ? "24h" : "7d"}
              </button>
            ))}
          </div>
        </header>
        {open && <LighthouseBody base={base} days={days} target2xPct={target2xPct} />}
      </div>
    </dialog>
  );
}

function LighthouseBody({ base, days, target2xPct }: { base: string; days: Days; target2xPct: number }) {
  const q = usePolling<MarketLighthouse>(path(base, days), 300_000);
  if (!q.data) {
    if (q.error) return <p className="error">Couldn&apos;t load the Lighthouse: {q.error.message}</p>;
    return (
      <div className="stack">
        <Skeleton lines={2} height={56} />
        <Skeleton lines={6} />
      </div>
    );
  }
  const d = q.data;
  const order = d.tide.series.map((s) => s.label).filter((l) => l !== "other");
  const cls = seriesClassFor(order);
  const span = days === 1 ? "24 hours" : "7 days";

  if (d.reads.total === 0) {
    return (
      <div className="lh-empty">
        <span className="lh-empty-icon" aria-hidden>
          <LighthouseIcon size={34} />
        </span>
        <h3>{d.tokenSage.on ? "No reads yet in this window" : "The light is off"}</h3>
        <p className="muted">
          {d.tokenSage.on
            ? `TokenSage is on, but nothing was read in the last ${span}. New coins show here as the scanner asks about them.`
            : "TokenSage isn't reading coins right now, so there is nothing to show. The Lighthouse fills in as soon as it is switched on."}
        </p>
      </div>
    );
  }

  const quickOnly = d.reads.deep === 0;
  return (
    <div className={`stack lh-content${q.stale ? " stale" : ""}`} aria-busy={q.stale}>
      {!d.tokenSage.on && (
        <p className="notice">
          TokenSage isn&apos;t reading new coins right now. These are the reads it stored before it went quiet
          {d.reads.newestAt ? <> (newest {ago(d.reads.newestAt)})</> : null}.
        </p>
      )}

      <section className="lh-kpis" aria-label="Headline numbers">
        <Kpi
          label="Coins read"
          value={d.reads.described.toLocaleString()}
          sub={
            <>
              last {span}
              {d.reads.newestAt ? <> · newest {ago(d.reads.newestAt)}</> : null}
            </>
          }
        />
        <Kpi
          label="Deep reads"
          value={pct(share(d.reads.deep, d.reads.described))}
          sub={
            quickOnly ? "quick reads only for now" : `${d.reads.deep.toLocaleString()} with X and news checks`
          }
        />
        <Kpi
          label="Story confidence"
          value={d.avgReferentConfidence === null ? "–" : pct(d.avgReferentConfidence * 100)}
          sub="how sure TokenSage is what a coin is about"
          meter={d.avgReferentConfidence}
        />
        <Kpi
          label="Copycats"
          value={pct(share(countOf(d.copies, "copies a recent coin"), sumOf(d.copies)))}
          sub="copy a coin launched in the last 30 days"
        />
      </section>

      <Section
        title="Narrative tide"
        note={`Coins read per ${d.window.bucketHours === 1 ? "hour" : "6 hours"}, by the narrative TokenSage is surest of.`}
      >
        <Tide d={d} cls={cls} />
      </Section>

      <div className="lh-grid">
        <Section
          title="Narrative mix"
          note={`Share of the ${d.reads.described.toLocaleString()} coins read.`}
        >
          <Donut d={d} cls={cls} />
        </Section>
        <Section title="Hottest sub-narratives" note="Coins carrying each label, any confidence.">
          {d.categories.length ? (
            <HBarChart
              data={d.categories.slice(0, 8).map((c) => ({
                label: words(c.label.replace("/", " › ")),
                value: c.count,
                display: c.count.toLocaleString(),
              }))}
            />
          ) : (
            <p className="muted small">No sub-categories in this window.</p>
          )}
        </Section>
      </div>

      <Section
        title="Which narratives double"
        note={`Model calls in the last ${span} that reached 2x, by their coin's narrative. The line is the ${target2xPct}% goal. TokenSage can answer after a call, so this shows what wins, not what a model knew.`}
      >
        <HitRates rows={d.outcomes.byCategory} target={target2xPct} cls={cls} />
        <p className="faint small lh-foot">
          {d.outcomes.described.toLocaleString()} of {d.outcomes.alerts.toLocaleString()} calls had a
          TokenSage read · {d.outcomes.graded.toLocaleString()} graded overall
          {d.outcomes.graded > 0 ? <>, {pct(share(d.outcomes.won2x, d.outcomes.graded))} reached 2x</> : null}
          .
        </p>
      </Section>

      <div className="lh-grid">
        <Section
          title="Where the story comes from"
          note="The inputs that pointed TokenSage at what a coin is about."
        >
          <CountBars rows={d.referentSupport} empty="Nothing in this window." />
        </Section>
        <Section title="What the coins are about" note="The kind of thing each coin refers to.">
          <CountBars rows={d.referentKinds} empty="Nothing in this window." />
        </Section>
      </div>

      <Section title="Flags raised" note="Warnings TokenSage attached to the coins it read.">
        <CountBars rows={d.flags} empty="No flags raised in this window." tone="warn" />
      </Section>

      <Section title="Signals at a glance" note="Each bar is 100% of the coins that had that signal read.">
        <div className="lh-splits">
          <Split
            title="X link check"
            rows={d.xVerdicts}
            empty={quickOnly ? "Waits on deep reads" : "No linked posts read"}
          />
          <Split
            title="In the news"
            rows={d.news}
            empty={quickOnly ? "Waits on deep reads" : "Not read yet"}
          />
          <Split title="Original or copy" rows={d.copies} empty="Not said yet" />
          <Split title="Trades against" rows={d.pairKinds} empty="Not said yet" />
        </div>
        {d.outcomes.byXVerdict.length > 0 && (
          <div className="lh-mini">
            <h4>Calls by X link verdict</h4>
            <HitRates rows={d.outcomes.byXVerdict} target={target2xPct} />
          </div>
        )}
        {d.outcomes.byCopy.length > 0 && (
          <div className="lh-mini">
            <h4>Calls on originals vs copies</h4>
            <HitRates rows={d.outcomes.byCopy} target={target2xPct} />
          </div>
        )}
      </Section>
    </div>
  );
}

const sumOf = (rows: LighthouseCount[]) => rows.reduce((s, r) => s + r.count, 0);
const countOf = (rows: LighthouseCount[], label: string) => rows.find((r) => r.label === label)?.count ?? 0;

function Kpi({
  label,
  value,
  sub,
  meter,
}: {
  label: string;
  value: string;
  sub: React.ReactNode;
  meter?: number | null;
}) {
  return (
    <div className="lh-kpi">
      <span className="lh-kpi-label">{label}</span>
      <span className="lh-kpi-value num">{value}</span>
      {meter !== undefined && (
        <span className="lh-meter" aria-hidden>
          <span style={{ width: `${Math.round(Math.min(1, Math.max(0, meter ?? 0)) * 100)}%` }} />
        </span>
      )}
      <span className="muted small">{sub}</span>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="lh-section">
      <h3>{title}</h3>
      {note && <p className="faint small">{note}</p>}
      {children}
    </section>
  );
}

function bucketLabel(iso: string, bucketHours: number) {
  const t = new Date(iso);
  if (bucketHours === 1) return t.toLocaleTimeString([], { hour: "numeric" });
  return `${t.toLocaleDateString([], { weekday: "short" })} ${t.toLocaleTimeString([], { hour: "numeric" })}`;
}

/** Stacked columns: coins read per bucket, split by narrative. Hover or tap a column to read it. */
function Tide({ d, cls }: { d: MarketLighthouse; cls: (l: string) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const { buckets, series } = d.tide;
  const totals = buckets.map((_, i) => series.reduce((s, x) => s + (x.values[i] ?? 0), 0));
  const max = Math.max(1, ...totals);
  if (totals.every((t) => t === 0)) return <p className="muted small">No coins described in this window.</p>;
  // At rest the readout shows the newest bucket with reads in it (the current one may be empty yet).
  const latest = totals.reduce((last, t, i) => (t > 0 ? i : last), totals.length - 1);
  const shown = hover ?? latest;
  // Bottom-up: the biggest narrative sits on the baseline.
  const stack = series;
  const tickEvery = Math.ceil(buckets.length / 6);
  return (
    <div className="lh-tide">
      <Legend labels={series.map((s) => s.label)} cls={cls} />
      <div className="lh-readout" aria-live="polite">
        <strong>{bucketLabel(buckets[shown]!, d.window.bucketHours)}</strong>
        <span className="num">{totals[shown]!.toLocaleString()} coins</span>
        {stack
          .filter((s) => (s.values[shown] ?? 0) > 0)
          .map((s) => (
            <span key={s.label} className="lh-readout-item">
              <span className={`lh-swatch ${cls(s.label)}`} />
              {words(s.label)} <span className="num">{s.values[shown]}</span>
            </span>
          ))}
      </div>
      <div
        className="lh-cols"
        role="img"
        aria-label={`Coins read per bucket, peaking at ${max.toLocaleString()}`}
        onMouseLeave={() => setHover(null)}
      >
        {buckets.map((b, i) => (
          <div
            key={b}
            className={`lh-col${hover === i ? " is-hover" : ""}`}
            onMouseEnter={() => setHover(i)}
            onClick={() => setHover(i)}
          >
            <div className="lh-col-stack" style={{ height: `${(totals[i]! / max) * 100}%` }}>
              {stack.map((s) =>
                (s.values[i] ?? 0) > 0 ? (
                  <span
                    key={s.label}
                    className={cls(s.label)}
                    style={{ flexGrow: s.values[i], flexBasis: 0 }}
                  />
                ) : null,
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="lh-axis" aria-hidden>
        {buckets.map((b, i) => (
          <span key={b}>{i % tickEvery === 0 ? bucketLabel(b, d.window.bucketHours) : ""}</span>
        ))}
      </div>
    </div>
  );
}

function Legend({ labels, cls }: { labels: string[]; cls: (l: string) => string }) {
  return (
    <ul className="lh-legend">
      {labels.map((l) => (
        <li key={l}>
          <span className={`lh-swatch ${cls(l)}`} />
          {words(l)}
        </li>
      ))}
    </ul>
  );
}

/** The tide's totals as a ring, the same colors, labeled beside it. */
function Donut({ d, cls }: { d: MarketLighthouse; cls: (l: string) => string }) {
  const [hover, setHover] = useState<string | null>(null);
  const parts = d.tide.series
    .map((s) => ({ label: s.label, n: s.values.reduce((a, b) => a + b, 0) }))
    .filter((p) => p.n > 0);
  const total = parts.reduce((s, p) => s + p.n, 0);
  if (total === 0) return <p className="muted small">No coins described in this window.</p>;
  const r = 40;
  const c = 2 * Math.PI * r;
  // A 2px-ish gap between segments, in arc length, unless a segment is too thin to spare it.
  const gap = parts.length > 1 ? 1.6 : 0;
  let offset = 0;
  const focus = parts.find((p) => p.label === hover) ?? parts[0]!;
  return (
    <div className="lh-donut">
      <svg viewBox="0 0 100 100" role="img" aria-label="Narrative mix" onMouseLeave={() => setHover(null)}>
        <circle cx="50" cy="50" r={r} className="lh-donut-track" />
        {parts.map((p) => {
          const len = (p.n / total) * c;
          const dash = Math.max(0.5, len - gap);
          const el = (
            <circle
              key={p.label}
              cx="50"
              cy="50"
              r={r}
              className={`lh-donut-seg ${cls(p.label)}${hover && hover !== p.label ? " dim" : ""}`}
              strokeDasharray={`${dash} ${c - dash}`}
              strokeDashoffset={-offset}
              transform="rotate(-90 50 50)"
              onMouseEnter={() => setHover(p.label)}
            />
          );
          offset += len;
          return el;
        })}
        <text x="50" y="49" textAnchor="middle" className="lh-donut-value">
          {pct(share(focus.n, total))}
        </text>
        <text x="50" y="61" textAnchor="middle" className="lh-donut-sub">
          {words(focus.label).slice(0, 14)}
        </text>
      </svg>
      <ul className="lh-donut-list">
        {parts.map((p) => (
          <li
            key={p.label}
            className={hover === p.label ? "is-hover" : ""}
            onMouseEnter={() => setHover(p.label)}
            onMouseLeave={() => setHover(null)}
          >
            <span className={`lh-swatch ${cls(p.label)}`} />
            <span className="lh-donut-label">{words(p.label)}</span>
            <span className="num muted">{pct(share(p.n, total))}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CountBars({ rows, empty, tone }: { rows: LighthouseCount[]; empty: string; tone?: "warn" }) {
  if (!rows.length) return <p className="muted small">{empty}</p>;
  return (
    <div className={tone === "warn" ? "lh-warnbars" : undefined}>
      <HBarChart
        data={rows.slice(0, 8).map((r) => ({
          label: words(r.label),
          value: r.count,
          display: r.count.toLocaleString(),
        }))}
      />
    </div>
  );
}

/** One 100% bar: each answer's share of the coins that had the signal read. */
function Split({ title, rows, empty }: { title: string; rows: LighthouseCount[]; empty: string }) {
  const total = sumOf(rows);
  return (
    <div className="lh-split">
      <div className="lh-split-head">
        <span>{title}</span>
        {total > 0 && <span className="faint small num">{total.toLocaleString()} read</span>}
      </div>
      {total === 0 ? (
        <div className="lh-split-bar empty">
          <span className="faint small">{empty}</span>
        </div>
      ) : (
        <>
          <div
            className="lh-split-bar"
            role="img"
            aria-label={rows.map((r) => `${words(r.label)} ${pct(share(r.count, total))}`).join(", ")}
          >
            {rows.map((r, i) => (
              <span
                key={r.label}
                className={i < 5 ? `lh-s${i + 1}` : "lh-other"}
                style={{ flexGrow: r.count, flexBasis: 0 }}
                title={`${words(r.label)}: ${r.count.toLocaleString()} (${pct(share(r.count, total))})`}
              />
            ))}
          </div>
          <ul className="lh-split-legend">
            {rows.slice(0, 5).map((r, i) => (
              <li key={r.label}>
                <span className={`lh-swatch lh-s${i + 1}`} />
                {words(r.label)} <span className="num muted">{pct(share(r.count, total))}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** Hit rates against the goal, one row per group; thin samples say so instead of a verdict. */
function HitRates({
  rows,
  target,
  cls,
}: {
  rows: LighthouseTally[];
  target: number;
  cls?: (l: string) => string;
}) {
  if (!rows.length)
    return <p className="muted small">No model calls on described coins in this window yet.</p>;
  return (
    <div className="lh-hits" style={{ ["--lh-target" as string]: `${target}%` }}>
      {rows.map((r) => {
        const rate = r.graded > 0 ? (r.won2x / r.graded) * 100 : null;
        const early = r.graded < MIN_GRADED;
        const met = !early && rate !== null && rate >= target;
        return (
          <div key={r.label} className={`lh-hit${early ? " early" : ""}`}>
            <span className="lh-hit-label">
              {cls && <span className={`lh-swatch ${cls(r.label)}`} />}
              {words(r.label)}
            </span>
            <span className="lh-hit-track">
              <span className="lh-hit-fill" style={{ width: `${Math.max(rate ?? 0, 1)}%` }} />
              <span className="lh-hit-goal" aria-hidden />
            </span>
            <span className="lh-hit-value num">{rate === null ? "–" : pct(rate)}</span>
            <span className={`lh-hit-state state ${early ? "early" : met ? "met" : "below"}`}>
              {early
                ? `${r.graded}/${MIN_GRADED} graded`
                : met
                  ? `✓ ${r.graded} graded`
                  : `▼ ${r.graded} graded`}
            </span>
          </div>
        );
      })}
    </div>
  );
}
