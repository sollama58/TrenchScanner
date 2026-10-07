import { useEffect, useRef, useState } from "react";
import type { LighthouseCount, LighthouseTally, MarketLighthouse } from "../api";
import { usePolling } from "../hooks";
import { ago, pct, signedPct, usd } from "../format";
import { HBarChart, Skeleton } from "./Charts";
import { CloseIcon, InfoIcon, LighthouseIcon } from "./Icons";

/**
 * The Market Lighthouse, beside Stats on the Live tab: how every token that passed the pre-checks
 * did, then what TokenSage sees across the new coins the scanner reads - which narratives are
 * rising, where their stories come from, what gets flagged - and how the models' calls did by
 * narrative. Aggregates only (see the API's marketLighthouse.ts), so guests read
 * the same answer as subscribers without seeing any live coin early.
 *
 * Colors: the tide and the mix share one mapping, the categorical slots --series-1..5 in fixed
 * order for the biggest narratives, then a neutral "other". Every chart names its series in a
 * legend or a label beside the mark, never color alone.
 */

export const WINDOWS = [1, 7] as const;
export type Days = (typeof WINDOWS)[number];

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
 * The Live tab's Lighthouse button, beside Stats, and the modal it opens. Guests get it too: the
 * answer is aggregates only, so it gives nothing away ahead of their delayed feed.
 */
export function LighthouseButton({ base }: { base: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="ghost stats-btn lh-btn"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        title="Market Lighthouse: how screened tokens are doing and what TokenSage sees across new coins"
      >
        <LighthouseIcon size={14} />
        Lighthouse
      </button>
      <MarketLighthouseModal open={open} onClose={() => setOpen(false)} base={base} />
    </>
  );
}

export function MarketLighthouseModal({
  open,
  onClose,
  base,
}: {
  open: boolean;
  onClose: () => void;
  base: string;
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
                At a glance: how the tokens that pass our pre-checks are doing, and what TokenSage sees across
                new coins. The Lighthouse tab has the charts, breakdowns and months of history.
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
        {open && <LighthouseBody base={base} days={days} compact />}
        <p className="lh-more">
          <a className="button" href="#lighthouse" onClick={onClose}>
            <LighthouseIcon size={14} />
            Open the Lighthouse tab
          </a>
          <span className="faint small">
            charts per hour, day or week, breakdowns by narrative, CSV export
          </span>
        </p>
      </div>
    </dialog>
  );
}

/**
 * One window's answer. The Lighthouse tab's "right now" shows the whole of it; the Live tab's
 * modal shows the compact form - the headline numbers only, with the tab a click away.
 */
export function LighthouseBody({
  base,
  days,
  compact = false,
}: {
  base: string;
  days: Days;
  compact?: boolean;
}) {
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

  const quickOnly = d.reads.deep === 0;
  return (
    <div className={`stack lh-content${q.stale ? " stale" : ""}`} aria-busy={q.stale}>
      <Screened s={d.screened} span={span} compact={compact} />
      <h3 className="lh-part">
        What TokenSage sees
        <span className={`lh-pill ${d.tokenSage.on ? "on" : "off"}`}>
          <span className="lh-pill-dot" aria-hidden />
          {d.tokenSage.on ? "live" : "off"}
        </span>
      </h3>
      {d.reads.total === 0 ? (
        <div className="lh-empty">
          <span className="lh-empty-icon" aria-hidden>
            <LighthouseIcon size={34} />
          </span>
          <h3>{d.tokenSage.on ? "No reads yet in this window" : "The light is off"}</h3>
          <p className="muted">
            {d.tokenSage.on
              ? `TokenSage is on, but nothing was read in the last ${span}. New coins show here as the scanner asks about them.`
              : "TokenSage isn't reading coins right now, so there is nothing to show here. This part fills in as soon as it is switched on."}
          </p>
        </div>
      ) : compact ? (
        <TokenSageGlance d={d} cls={cls} />
      ) : (
        <TokenSageSections d={d} span={span} cls={cls} quickOnly={quickOnly} />
      )}
    </div>
  );
}

function TokenSageSections({
  d,
  span,
  cls,
  quickOnly,
}: {
  d: MarketLighthouse;
  span: string;
  cls: (l: string) => string;
  quickOnly: boolean;
}) {
  return (
    <>
      <TokenSageKpis d={d} span={span} />

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
        title="Which narratives pay"
        note={`Model calls in the last ${span} by their coin's narrative: the average return under the exit plan, and how many reached 2x, 4x and 10x. TokenSage can answer after a call, so this shows what wins, not what a model knew.`}
      >
        <HitRates rows={bestFirst(d.outcomes.byCategory)} cls={cls} />
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
            <HitRates rows={d.outcomes.byXVerdict} />
          </div>
        )}
        {d.outcomes.byCopy.length > 0 && (
          <div className="lh-mini">
            <h4>Calls on originals vs copies</h4>
            <HitRates rows={d.outcomes.byCopy} />
          </div>
        )}
      </Section>
    </>
  );
}

/**
 * The modal's TokenSage half: what the coins are (original or copy, what they trade against),
 * the narrative mix, and the narratives whose calls are doubling most. The read counts and
 * confidence figures stay on the Lighthouse tab, where someone digging in wants them.
 */
function TokenSageGlance({ d, cls }: { d: MarketLighthouse; cls: (l: string) => string }) {
  const best = bestFirst(d.outcomes.byCategory).slice(0, 5);
  return (
    <>
      {!d.tokenSage.on && (
        <p className="notice">
          TokenSage isn&apos;t reading new coins right now. These are the reads it stored before it went quiet
          {d.reads.newestAt ? <> (newest {ago(d.reads.newestAt)})</> : null}.
        </p>
      )}
      <div className="lh-splits">
        <Split title="Original or copy" rows={d.copies} empty="Not said yet" />
        <Split title="Trades against" rows={d.pairKinds} empty="Not said yet" />
      </div>
      <div className="lh-grid">
        <Section
          title="Narrative mix"
          note={`Share of the ${d.reads.described.toLocaleString()} coins read.`}
        >
          <Donut d={d} cls={cls} />
        </Section>
        <Section
          title="Best-performing narratives"
          note="By the average return of model calls under the exit plan, with how many reached 2x, 4x and 10x."
        >
          <HitRates rows={best} cls={cls} />
        </Section>
      </div>
    </>
  );
}

/** TokenSage's headline numbers for the window. */
function TokenSageKpis({ d, span }: { d: MarketLighthouse; span: string }) {
  return (
    <>
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
    </>
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

/** A group's average return under the exit plan, once any of its calls has one. */
const avgReturn = (t: LighthouseTally) => (t.returnN > 0 ? t.returnSum / t.returnN : null);

/**
 * Best first: groups with a settled sample (five graded calls) ahead of thin ones, then by average
 * return under the exit plan, then by 2x rate, then by how many calls back it.
 */
export function bestFirst(rows: LighthouseTally[]): LighthouseTally[] {
  const settled = (t: LighthouseTally) => (t.graded >= MIN_GRADED ? 1 : 0);
  const rate2x = (t: LighthouseTally) => (t.graded > 0 ? t.won2x / t.graded : -1);
  return [...rows].sort(
    (a, b) =>
      settled(b) - settled(a) ||
      (avgReturn(b) ?? -Infinity) - (avgReturn(a) ?? -Infinity) ||
      rate2x(b) - rate2x(a) ||
      b.graded - a.graded,
  );
}

/**
 * One row per group: the average return under the exit plan (the bar, against the best row's),
 * the share of graded calls that reached 2x, 4x and 10x, and how many calls that rests on.
 */
function HitRates({ rows, cls }: { rows: LighthouseTally[]; cls?: (l: string) => string }) {
  if (!rows.length)
    return <p className="muted small">No model calls on described coins in this window yet.</p>;
  const top = Math.max(0, ...rows.map((r) => avgReturn(r) ?? 0));
  return (
    <div className="lh-hits">
      {rows.map((r) => {
        const ret = avgReturn(r);
        const early = r.graded < MIN_GRADED;
        const tier = (won: number) => (r.graded > 0 ? pct(share(won, r.graded)) : "–");
        const width = ret !== null && ret > 0 && top > 0 ? Math.max((ret / top) * 100, 1) : 1;
        return (
          <div key={r.label} className={`lh-hit${early ? " early" : ""}`}>
            <span className="lh-hit-label">
              {cls && <span className={`lh-swatch ${cls(r.label)}`} />}
              {words(r.label)}
            </span>
            <span className="lh-hit-track">
              <span className="lh-hit-fill" style={{ width: `${width}%` }} />
            </span>
            <span className="lh-hit-value num">{ret === null ? "–" : signedPct(ret)}</span>
            <span className="lh-hit-tiers muted">
              2x {tier(r.won2x)} · 4x {tier(r.won4x)} · 10x {tier(r.won10x)}
            </span>
            <span className="lh-hit-state muted">
              {early ? `${r.graded}/${MIN_GRADED} graded` : `${r.graded} graded`}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ---------- Screened tokens ----------

type ScreenedData = MarketLighthouse["screened"];

const TIERS = [
  { key: "hit2xPct", label: "2x within 15 min", short: "2x", cls: "lh-s1" },
  { key: "hit4xPct", label: "4x within 30 min", short: "4x", cls: "lh-s2" },
  { key: "hit10xPct", label: "10x within 1 hr", short: "10x", cls: "lh-s3" },
] as const;

function screenedBucketLabel(iso: string, bucketHours: number) {
  const t = new Date(iso);
  if (bucketHours >= 24) return t.toLocaleDateString([], { weekday: "short", day: "numeric" });
  return t.toLocaleTimeString([], { hour: "numeric" });
}

/**
 * How every token that cleared the pre-checks did from its decision moment: hit rates per tier
 * and the average return under the fixed exit plan, overall and per bucket. One axis per chart:
 * the rates share a 0-100% scale, the return gets its own chart around zero.
 */
function Screened({ s, span, compact = false }: { s: ScreenedData; span: string; compact?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const [explain, setExplain] = useState(false);
  const buckets = s.byBucket.filter((b) => b.graded > 0);
  const per = s.bucketHours >= 24 ? "day" : `${s.bucketHours} hours`;
  const rateMax = Math.max(
    10,
    ...buckets.flatMap((b) => [b.hit2xPct ?? 0, b.hit4xPct ?? 0, b.hit10xPct ?? 0]),
  );
  const top = Math.ceil(rateMax / 10) * 10;
  const retAbs = Math.max(5, ...buckets.map((b) => Math.abs(b.avgReturnPct ?? 0)));
  const latest = buckets.length - 1;
  const shown = hover !== null && hover <= latest ? hover : latest;
  const focus = buckets[shown];
  const summary = `A token counts once it passes the safety screen (authorities renounced, liquidity locked, not Mayhem Mode, no more than ${s.checks.freshWalletMaxPct}% fresh and under ${s.checks.emptyWalletRejectPct}% empty top-10 wallets) and looks ready to decide on.`;

  return (
    <section className="lh-section lh-screened">
      <div className="lh-screened-head">
        <h3>How screened tokens did</h3>
        <button
          type="button"
          className="ghost lh-info"
          aria-expanded={explain}
          aria-controls="lh-checks"
          title={summary}
          onClick={() => setExplain((o) => !o)}
        >
          <InfoIcon size={14} />
          {explain ? "Hide the pre-checks" : "What are the pre-checks?"}
        </button>
      </div>
      <p className="faint small">
        Every token that passed our pre-checks in the last {span}, graded from the price when it first looked
        ready. This is the whole field the models pick from, not their calls.
      </p>
      {explain && <PreChecks s={s} />}

      <div className="lh-kpis lh-tier-kpis">
        {TIERS.map((t) => (
          <div key={t.key} className="lh-kpi">
            <span className="lh-kpi-label">
              <span className={`lh-swatch ${t.cls}`} /> Hit {t.label}
            </span>
            <span className="lh-kpi-value num">{pct(s[t.key], 1)}</span>
            <span className="muted small">
              {t.key === "hit10xPct"
                ? `${s.tenXGraded.toLocaleString()} settled`
                : `${s.graded.toLocaleString()} graded`}
            </span>
          </div>
        ))}
        <div className="lh-kpi">
          <span className="lh-kpi-label">Average return</span>
          <span className={`lh-kpi-value num ${retTone(s.avgReturnPct)}`}>
            {signedPct(s.avgReturnPct, 1)}
          </span>
          <span className="muted small" title={`Exit plan: ${s.exitPlan}`}>
            on the exit plan · {s.returnGraded.toLocaleString()} graded
          </span>
        </div>
      </div>

      {compact ? null : buckets.length === 0 ? (
        <p className="muted small">No screened tokens have been graded in this window yet.</p>
      ) : (
        <div className="lh-screened-charts" onMouseLeave={() => setHover(null)}>
          <ul className="lh-legend">
            {TIERS.map((t) => (
              <li key={t.key}>
                <span className={`lh-swatch ${t.cls}`} />
                {t.short} rate
              </li>
            ))}
          </ul>
          {focus && (
            <div className="lh-readout" aria-live="polite">
              <strong>{screenedBucketLabel(focus.at, s.bucketHours)}</strong>
              <span className="num">{focus.graded.toLocaleString()} graded</span>
              {TIERS.map((t) => (
                <span key={t.key} className="lh-readout-item">
                  <span className={`lh-swatch ${t.cls}`} />
                  {t.short} <span className="num">{pct(focus[t.key], 1)}</span>
                </span>
              ))}
              <span className="lh-readout-item">
                avg return <span className="num">{signedPct(focus.avgReturnPct, 1)}</span>
              </span>
            </div>
          )}
          <div className="lh-rate-chart">
            <span className="lh-yaxis" aria-hidden>
              <span>{top}%</span>
              <span>{top / 2}%</span>
              <span>0%</span>
            </span>
            <div
              className="lh-groups"
              role="img"
              aria-label={`Hit rates of screened tokens per ${per}: 2x ${pct(s.hit2xPct, 1)}, 4x ${pct(s.hit4xPct, 1)}, 10x ${pct(s.hit10xPct, 1)} overall`}
            >
              {buckets.map((b, i) => (
                <div
                  key={b.at}
                  className={`lh-group${hover === i ? " is-hover" : ""}`}
                  onMouseEnter={() => setHover(i)}
                  onClick={() => setHover(i)}
                >
                  {TIERS.map((t) => (
                    <span
                      key={t.key}
                      className={`lh-gbar ${t.cls}`}
                      style={{ height: `${Math.max(0.5, ((b[t.key] ?? 0) / top) * 100)}%` }}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
          <h4 className="lh-subchart">Average return per {per}</h4>
          <div className="lh-rate-chart">
            <span className="lh-yaxis" aria-hidden>
              <span>+{Math.round(retAbs)}%</span>
              <span>0%</span>
              <span>−{Math.round(retAbs)}%</span>
            </span>
            <div
              className="lh-ret"
              role="img"
              aria-label={`Average return of screened tokens per ${per}, ${signedPct(s.avgReturnPct, 1)} overall`}
            >
              {buckets.map((b, i) => {
                const v = b.avgReturnPct ?? 0;
                const h = (Math.abs(v) / retAbs) * 50;
                return (
                  <div
                    key={b.at}
                    className={`lh-ret-col${hover === i ? " is-hover" : ""}`}
                    onMouseEnter={() => setHover(i)}
                    onClick={() => setHover(i)}
                  >
                    {b.avgReturnPct !== null && (
                      <span
                        className={`lh-ret-bar ${v >= 0 ? "up" : "down"}`}
                        style={{ height: `${Math.max(0.5, h)}%` }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="lh-axis lh-axis-inset" aria-hidden>
            {buckets.map((b, i) => (
              <span key={b.at}>
                {i % Math.ceil(buckets.length / 7) === 0 ? screenedBucketLabel(b.at, s.bucketHours) : ""}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

const retTone = (v: number | null) => (v === null ? "" : v >= 0 ? "lh-up" : "lh-down");

/** The pre-checks in words, from the numbers the API actually applies. */
function PreChecks({ s }: { s: ScreenedData }) {
  const c = s.checks;
  return (
    <div id="lh-checks" className="lh-checks">
      <div>
        <h4>1. Safety screen</h4>
        <p className="muted small">Every token, before anyone sees it. It can&apos;t be switched off.</p>
        <ul>
          <li>Mint and freeze authority renounced, so supply can&apos;t be inflated or holders frozen.</li>
          <li>Liquidity burned or locked on its own pool, so it can&apos;t be pulled.</li>
          <li>Not a Pump.fun Mayhem Mode token, whose early trading is run by bots.</li>
          <li>No more than {c.freshWalletMaxPct}% of the top 10 holders on wallets under a day old.</li>
          <li>Under {c.emptyWalletRejectPct}% of the top 10 holders on otherwise empty wallets.</li>
        </ul>
        <p className="faint small">Anything that can&apos;t be checked fails.</p>
      </div>
      <div>
        <h4>2. Ready to decide on</h4>
        <p className="muted small">The moment a token is graded from, once per window.</p>
        <ul>
          <li>
            Market cap between {usd(c.mcapMinUsd)} and {usd(c.mcapMaxUsd)}.
          </li>
          <li>Under {Math.round(c.maxAgeMinutes / 60)} hours old.</li>
          <li>At least {c.minBuySharePct}% of the last hour&apos;s trades are buys.</li>
          <li>Price not falling over the last 5 minutes.</li>
          <li>Holder wallet checks finished.</li>
        </ul>
      </div>
      <p className="faint small lh-checks-foot">
        Average return is what each token would have made on our fixed exit plan. {s.exitPlan}
      </p>
    </div>
  );
}
