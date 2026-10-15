import { useEffect, useState } from "react";
import type { LighthouseCount, LighthouseSignals, LighthouseTally, MarketLighthouse } from "../api";
import { usePolling } from "../hooks";
import { lighthousePath } from "../routes";
import { ago, halfHour, pct, signedPct, usd } from "../format";
import { narrativeBaseline, relativeScale, signedPts, type NarrativeBaseline } from "../lighthouseMetrics";
import { intervalText, MIN_GRADED_FOR_RATE, RULE_NOTE_UNFILTERED, wilson } from "../rates";
import { HBarChart, Skeleton } from "./Charts";
import { InfoIcon, LighthouseIcon } from "./Icons";
import {
  renderNarrativeMixCard,
  renderNarrativesPayCard,
  renderScreenedCard,
  renderSignalsCard,
  renderSubNarrativesCard,
  renderTokenSageCard,
} from "./lighthouseCards";
import { SafetyGauge } from "./SafetyGauge";
import { ShareButton } from "./ShareImageDialog";
import { WeatherGauge } from "./WeatherGauge";
import { PRICING_CHANGE_LABEL, pricingChangeSlot } from "../pricingChange";

/**
 * The Market Lighthouse, at the top of the Lighthouse tab: how every token that passed the pre-checks
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

/** "Signals at a glance" reads further back than the rest: a day, a week or a month. */
const SIGNAL_WINDOWS = [1, 7, 30] as const;
type SignalDays = (typeof SIGNAL_WINDOWS)[number];
const windowLabel = (days: number) => (days === 1 ? "24h" : days === 7 ? "7d" : "1mo");
const spanOf = (days: number) => (days === 1 ? "24 hours" : `${days} days`);
/** A share image's file name for a window: "trenchscanner-narrative-mix-24h". */
const fileFor = (name: string, days: number) => `trenchscanner-${name}-${windowLabel(days)}`;

/** Graded alerts below which a narrative's hit rate shows as early rather than as a verdict. */
export const MIN_GRADED = MIN_GRADED_FOR_RATE;

/** TokenSage's codes ("x_link_reused", "about_this_coin") as words. */
export const words = (code: string) => code.replace(/[_-]+/g, " ").trim();

const share = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : null);

/** Series class for a label: the tide's order decides it, so the mix and the tide agree. */
export function seriesClassFor(order: string[]) {
  return (label: string) => {
    const i = order.indexOf(label);
    return label === "other" || i < 0 ? "lh-other" : `lh-s${i + 1}`;
  };
}

/** One window's answer, the Lighthouse tab's "right now". */
export function LighthouseBody(props: { base: string; days: Days }) {
  // The weather gauge reads its own endpoint, so it shows whether or not the window has loaded.
  return (
    <div className="stack">
      <WeatherGauge base={props.base} />
      <LighthouseWindow {...props} />
    </div>
  );
}

function LighthouseWindow({ base, days }: { base: string; days: Days }) {
  const q = usePolling<MarketLighthouse>(lighthousePath(base, days), 300_000);
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

  return (
    <div className={`stack lh-content${q.stale ? " stale" : ""}`} aria-busy={q.stale}>
      {d.safetyScreen && <SafetyGauge s={d.safetyScreen} span={span} days={days} />}
      <Screened s={d.screened} span={span} days={days} />
      <h3 className="lh-part">
        What TokenSage sees
        <span className={`lh-pill ${d.tokenSage.on ? "on" : "off"}`}>
          <span className="lh-pill-dot" aria-hidden />
          {d.tokenSage.on ? "live" : "off"}
        </span>
        {d.reads.total > 0 && (
          <span className="lh-part-share">
            <ShareButton
              title={`What TokenSage sees, last ${span}`}
              fileName={fileFor("tokensage", days)}
              caption={`TrenchScanner: ${d.reads.described.toLocaleString("en-US")} new coins read by TokenSage in the last ${span}`}
              render={() => renderTokenSageCard(d, span)}
            />
          </span>
        )}
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
      ) : (
        <TokenSageSections d={d} base={base} days={days} span={span} cls={cls} />
      )}
    </div>
  );
}

function TokenSageSections({
  d,
  base: apiBase,
  days,
  span,
  cls,
}: {
  d: MarketLighthouse;
  base: string;
  days: Days;
  span: string;
  cls: (l: string) => string;
}) {
  const base = narrativeBaseline(d.outcomes.byCategory);
  return (
    <>
      <TokenSageKpis d={d} span={span} />

      <div className="lh-grid">
        <Section
          title="Narrative mix"
          note={`Share of the ${d.reads.described.toLocaleString()} coins read.`}
          share={
            <ShareButton
              title={`Narrative mix, last ${span}`}
              fileName={fileFor("narrative-mix", days)}
              caption={`TrenchScanner: the narrative mix of new Solana coins, last ${span}`}
              render={() => renderNarrativeMixCard(d, span)}
            />
          }
        >
          <Donut d={d} cls={cls} />
        </Section>
        <Section
          title="Hottest sub-narratives"
          note="Coins carrying each label, any confidence."
          share={
            <ShareButton
              title={`Hottest sub-narratives, last ${span}`}
              fileName={fileFor("sub-narratives", days)}
              caption={`TrenchScanner: the hottest sub-narratives on new Solana coins, last ${span}`}
              disabled={d.categories.length === 0}
              render={() => renderSubNarrativesCard(d, span)}
            />
          }
        >
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
        share={
          <ShareButton
            title={`Which narratives pay, last ${span}`}
            fileName={fileFor("narratives-pay", days)}
            caption={`TrenchScanner: which narratives pay, last ${span}`}
            disabled={narratives(d.outcomes.byCategory).length === 0}
            render={() => renderNarrativesPayCard(d.outcomes, span)}
          />
        }
        note={`Model calls in the last ${span} by their coin's narrative, against the average of every call: how many points each narrative's average return under the exit plan sits above or below it, with its own return and 2x rate (and that rate's gap to the average). Narratives under ${MIN_GRADED} graded calls stay faded; hover one for its 2x rate's 90% range. TokenSage can answer after a call, so this shows what wins, not what a model knew. ${RULE_NOTE_UNFILTERED}`}
      >
        <HitRates rows={narratives(d.outcomes.byCategory)} cls={cls} baseline={base} />
        <p className="faint small lh-foot">
          {d.outcomes.described.toLocaleString()} of {d.outcomes.alerts.toLocaleString()} calls had a
          TokenSage read · {d.outcomes.graded.toLocaleString()} graded overall
          {d.outcomes.graded > 0 ? <>, {pct(share(d.outcomes.won2x, d.outcomes.graded))} reached 2x</> : null}
          . The average each narrative is read against is every call with a read: {signedPct(base.avgReturn)}{" "}
          return, {pct(base.rate2x)} reached 2x, over {base.graded.toLocaleString()} graded.
        </p>
      </Section>

      <SignalsAtAGlance d={d} base={apiBase} days={days} />
    </>
  );
}

/**
 * "Signals at a glance", with its own 24h / 7d / 1mo switch. It follows the window above until
 * someone picks one here; a pick matching that window reads from the answer already on screen,
 * any other from the signals-only route, which the API keeps warm per window.
 */
function SignalsAtAGlance({ d, base, days }: { d: MarketLighthouse; base: string; days: Days }) {
  const [picked, setPicked] = useState<SignalDays | null>(null);
  const [fetched, setFetched] = useState<{ days: number; s: LighthouseSignals } | null>(null);
  const shown = picked ?? days;
  const s: LighthouseSignals | null = shown === days ? d : fetched?.days === shown ? fetched.s : null;
  return (
    <section className="lh-section">
      <div className="lh-section-head">
        <h3>Signals at a glance</h3>
        <div className="lh-head-tools">
          <ShareButton
            title={`Signals at a glance, last ${spanOf(shown)}`}
            fileName={fileFor("signals", shown)}
            caption={`TrenchScanner: what TokenSage found behind new Solana coins, last ${spanOf(shown)}`}
            disabled={!s}
            render={() =>
              renderSignalsCard({ ...s!, deep: s!.reads.deep, described: s!.reads.described }, spanOf(shown))
            }
          />
          <div className="segmented small" role="tablist" aria-label="Signals window">
            {SIGNAL_WINDOWS.map((w) => (
              <button
                key={w}
                role="tab"
                aria-selected={w === shown}
                className={w === shown ? "on" : ""}
                onClick={() => setPicked(w)}
              >
                {windowLabel(w)}
              </button>
            ))}
          </div>
        </div>
      </div>
      <p className="faint small">
        Coins read in the last {shown === 1 ? "24 hours" : shown === 7 ? "7 days" : "30 days"}. Each bar is
        100% of the coins that had that signal read.
      </p>
      {shown === days ? (
        <Signals
          s={{
            reads: d.reads,
            xVerdicts: d.xVerdicts,
            news: d.news,
            copies: d.copies,
            pairKinds: d.pairKinds,
            outcomes: d.outcomes,
          }}
        />
      ) : (
        <FetchedSignals base={base} days={shown} onData={(s) => setFetched({ days: shown, s })} />
      )}
    </section>
  );
}

function FetchedSignals({
  base,
  days,
  onData,
}: {
  base: string;
  days: number;
  /** Hands the answer up, for the section's share image. */
  onData: (s: LighthouseSignals) => void;
}) {
  const q = usePolling<LighthouseSignals>(`${base}/lighthouse/signals?days=${days}`, 300_000);
  useEffect(() => {
    if (q.data) onData(q.data);
    // onData is a fresh closure each render; the answer is what changes.
  }, [q.data]);
  if (!q.data) {
    if (q.error) return <p className="error">Couldn&apos;t load these signals: {q.error.message}</p>;
    return <Skeleton lines={4} />;
  }
  return (
    <div className={q.stale ? "stale" : undefined} aria-busy={q.stale}>
      <Signals s={q.data} />
    </div>
  );
}

function Signals({
  s,
}: {
  s: Pick<LighthouseSignals, "xVerdicts" | "news" | "copies" | "pairKinds"> & {
    reads: { described: number; deep: number };
    outcomes: { byCopy: LighthouseTally[] };
  };
}) {
  const quickOnly = s.reads.deep === 0;
  return (
    <>
      <div className="lh-splits">
        <Split
          title="X link check"
          rows={s.xVerdicts}
          empty={quickOnly ? "Waits on deep reads" : "No linked posts read"}
        />
        <Split title="In the news" rows={s.news} empty={quickOnly ? "Waits on deep reads" : "Not read yet"} />
        <Split title="Original or copy" rows={s.copies} empty="Not said yet" />
        <Split title="Trades against" rows={s.pairKinds} empty="Not said yet" />
      </div>
      {s.outcomes.byCopy.length > 0 && (
        <div className="lh-mini">
          <h4>Calls on originals vs copies</h4>
          <HitRates rows={s.outcomes.byCopy} />
        </div>
      )}
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

function Section({
  title,
  note,
  share,
  children,
}: {
  title: string;
  note?: string;
  /** The section's Share button, beside its title. */
  share?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="lh-section">
      {share ? (
        <div className="lh-section-head">
          <h3>{title}</h3>
          {share}
        </div>
      ) : (
        <h3>{title}</h3>
      )}
      {note && <p className="faint small">{note}</p>}
      {children}
    </section>
  );
}

/** The window's narrative totals as a ring, labeled beside it. */
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
/**
 * The narrative rows worth ranking: best first, without "uncategorized", which is the coins
 * TokenSage couldn't file rather than a narrative. The API still tallies it, and the footer's
 * overall counts still include it.
 */
export const narratives = (rows: LighthouseTally[]) =>
  bestFirst(rows).filter((r) => r.label !== "uncategorized");

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

/** The bar's reach either side of zero: an average return past this is drawn full. */
const RETURN_SCALE = 100;

/**
 * One row per group: the average return under the exit plan as a bar from zero, green to the
 * right for a gain and red to the left for a loss on a -100% to +100% scale, then the share of
 * graded calls that reached 2x and 10x, and how many calls that rests on.
 *
 * With a baseline it reads relative strength instead: the bar grows from the all-narrative
 * average, by how many points the group's average return sits above or below it, and the 2x rate
 * carries its own gap to the average 2x rate. Thin groups stay dimmed with uncolored figures, so
 * a lucky three calls never reads as a strong narrative.
 */
export function HitRates({
  rows,
  cls,
  baseline,
}: {
  rows: LighthouseTally[];
  cls?: (l: string) => string;
  baseline?: NarrativeBaseline;
}) {
  if (!rows.length)
    return <p className="muted small">No model calls on described coins in this window yet.</p>;
  const base = baseline?.avgReturn ?? null;
  const relative = baseline !== undefined && base !== null;
  const gapOf = (r: LighthouseTally) => {
    const ret = avgReturn(r);
    return ret === null ? null : relative ? ret - base : ret;
  };
  const scale = relative
    ? relativeScale(rows.filter((r) => r.graded >= MIN_GRADED).map(gapOf))
    : RETURN_SCALE;
  const unit = relative ? " pts" : "%";
  return (
    <div className="lh-hits">
      <div className="lh-hit lh-hit-axis" aria-hidden>
        <span />
        <span className="lh-hit-scale">
          <i>
            -{scale}
            {unit}
          </i>
          <i>{relative ? `avg ${signedPct(base)}` : "0"}</i>
          <i>
            +{scale}
            {unit}
          </i>
        </span>
      </div>
      {rows.map((r) => {
        const ret = avgReturn(r);
        const gap = gapOf(r);
        const early = r.graded < MIN_GRADED;
        const tier = (won: number, over: number = r.graded) => (over > 0 ? pct(share(won, over)) : "–");
        const tenXOver = r.tenXGraded ?? r.graded;
        const r2x = share(r.won2x, r.graded);
        const gap2x = relative && r2x !== null && baseline.rate2x !== null ? r2x - baseline.rate2x : null;
        // Half the track is one side of the line; a hair of bar stays visible for a flat gap.
        const reach = gap === null ? 0 : Math.max(0.5, (Math.min(Math.abs(gap), scale) / scale) * 50);
        const tone = gap === null ? "" : gap < 0 ? "loss" : "gain";
        const valueTone = gap === null ? "" : relative && early ? "muted" : gap < 0 ? "lh-down" : "lh-up";
        const title = relative
          ? `${words(r.label)}: average return ${signedPct(ret)} against ${signedPct(base)} for all narratives (${signedPts(gap)}); 2x rate ${pct(r2x)} (${intervalText(wilson(r.won2x, r.graded))}) against ${pct(baseline.rate2x)}; 10x rate ${tier(r.won10x, tenXOver)}.${early ? " Too few graded calls to call it yet." : ""}`
          : undefined;
        return (
          <div key={r.label} className={`lh-hit${early ? " early" : ""}`} title={title}>
            <span className="lh-hit-label">
              {cls && <span className={`lh-swatch ${cls(r.label)}`} />}
              {words(r.label)}
            </span>
            <span className="lh-hit-track diverging">
              <span className="lh-hit-zero" />
              {gap !== null && <span className={`lh-hit-fill ${tone}`} style={{ width: `${reach}%` }} />}
            </span>
            <span className={`lh-hit-value num ${valueTone}`}>
              {relative ? signedPts(gap).replace(" pts", "") : signedPct(ret)}
            </span>
            <span className="lh-hit-tiers muted">
              {relative ? (
                <>
                  return {signedPct(ret)} · 2x {tier(r.won2x)}
                  {gap2x !== null && (
                    <span className={early ? "" : gap2x < 0 ? "lh-down" : gap2x > 0 ? "lh-up" : ""}>
                      {" "}
                      ({signedPts(gap2x).replace(" pts", "")})
                    </span>
                  )}
                </>
              ) : (
                <>
                  2x {tier(r.won2x)} · 10x {tier(r.won10x, tenXOver)}
                </>
              )}
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
  // Day buckets are UTC-aligned on the API; named in UTC so a browser west of it doesn't label
  // today's bucket with yesterday's date (the Lighthouse tab's ticks do the same).
  if (bucketHours >= 24)
    return t.toLocaleDateString([], { timeZone: "UTC", weekday: "short", day: "numeric" });
  return t.toLocaleTimeString([], { hour: "numeric", minute: halfHour(t) });
}

/**
 * How every token that cleared the pre-checks did from its decision moment: hit rates per tier
 * and the average return under the fixed exit plan, overall and per bucket. One axis per chart:
 * the rates share a 0-100% scale, the return gets its own chart around zero.
 */
function Screened({ s, span, days }: { s: ScreenedData; span: string; days: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const [explain, setExplain] = useState(false);
  const buckets = s.byBucket.filter((b) => b.graded > 0);
  const per = s.bucketHours >= 24 ? "day" : `${s.bucketHours} hours`;
  const change = pricingChangeSlot(
    buckets.map((b) => Date.parse(b.at)),
    s.bucketHours * 3_600_000,
  );
  // The second chart repeats the line without the label, under the first one's.
  const changeMark = (labelled: boolean) =>
    change === null ? null : (
      <span
        className={`lh-change${change / buckets.length > 0.6 ? " flip" : ""}`}
        style={{ left: `${(change / buckets.length) * 100}%` }}
        aria-label={labelled ? PRICING_CHANGE_LABEL : undefined}
      >
        {labelled && <span>{PRICING_CHANGE_LABEL}</span>}
      </span>
    );
  const rateMax = Math.max(
    10,
    ...buckets.flatMap((b) => [b.hit2xPct ?? 0, b.hit4xPct ?? 0, b.hit10xPct ?? 0]),
  );
  const top = Math.ceil(rateMax / 10) * 10;
  const retAbs = Math.max(5, ...buckets.map((b) => Math.abs(b.avgReturnPct ?? 0)));
  const latest = buckets.length - 1;
  const shown = hover !== null && hover <= latest ? hover : latest;
  const focus = buckets[shown];
  const summary = `A token counts once it passes the safety screen (authorities renounced, liquidity locked, not Mayhem Mode, no more than ${s.checks.freshWalletMaxPct}% fresh, under ${s.checks.emptyWalletRejectPct}% empty and under ${s.checks.sniperWalletRejectPct ?? 80}% launch-sniper top-10 wallets, top 10 owning under ${s.checks.top10HolderRejectPct ?? 40}%, no single holder over ${s.checks.largestHolderMaxPct ?? 10}%, under ${s.checks.linkedRejectCount ?? 20} of the top 25 linked and under ${s.checks.cexFundedRejectCount ?? 21} funded from an exchange${(s.checks.minPreBondSeconds ?? 5) > 0 ? `, bonding curve not filled inside ${s.checks.minPreBondSeconds ?? 5}s of launch` : ""}) and looks ready to decide on.`;

  return (
    <section className="lh-section lh-screened">
      <div className="lh-screened-head">
        <h3>How screened tokens did</h3>
        <div className="lh-head-tools">
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
          <ShareButton
            title={`How screened tokens did, last ${span}`}
            fileName={fileFor("screened", days)}
            caption={`TrenchScanner: ${pct(s.hit2xPct, 1)} of screened tokens hit 2x in the last ${span}`}
            disabled={s.graded === 0}
            render={() => renderScreenedCard(s, span)}
          />
        </div>
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

      {buckets.length === 0 ? (
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
              {changeMark(true)}
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
              {changeMark(false)}
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
      {s.byHourOfDay && <HourOfDay h={s.byHourOfDay} />}
    </section>
  );
}

const retTone = (v: number | null) => (v === null ? "" : v >= 0 ? "lh-up" : "lh-down");

/** Hours with fewer graded tokens than this are drawn faded: too few to read a rate from. */
const MIN_HOUR_GRADED = 30;

const hourLabel = (h: number, minutes = 0) =>
  `${String(((h % 24) + 24) % 24).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;

/**
 * The browser's clock against UTC: the offset split into whole hours (floored) and the minutes
 * past them, so a UTC hour falls on local hour `utc + offsetHours` starting `minutes` past it
 * (00:00 UTC is 05:30 in Kolkata: column 5, labelled 05:30), and a short name for the zone
 * ("PDT", "GMT+2", or "UTC+5:30" when the short one is just "GMT").
 */
function localClock(now = new Date()) {
  const offsetMinutes = -now.getTimezoneOffset();
  const offsetHours = Math.floor(offsetMinutes / 60);
  const minutes = offsetMinutes - offsetHours * 60;
  let name: string;
  try {
    name =
      new Intl.DateTimeFormat([], { timeZoneName: "short" })
        .formatToParts(now)
        .find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    name = "";
  }
  if (!name || name === "GMT" || name === "UTC") {
    const abs = Math.abs(offsetMinutes);
    const mm = abs % 60 ? `:${String(abs % 60).padStart(2, "0")}` : "";
    name = offsetMinutes === 0 ? "UTC" : `UTC${offsetMinutes > 0 ? "+" : "−"}${Math.floor(abs / 60)}${mm}`;
  }
  return { offsetHours, minutes, name };
}

/**
 * The screened field by hour of the day over everything the hourly rollup has kept: which
 * hours screen the most tokens, and which hours' tokens double and pay. The API sums per hour
 * in the browser's zone (the `tz` it was sent), each row on its own date's offset, so "5 am"
 * means the reader's 5 am on either side of a DST change. An older API, or a browser that
 * can't name its zone, gets UTC hours, and the columns are shifted by today's offset instead.
 * Three charts on one column per hour, so a reader lines up busy against good.
 */
function HourOfDay({ h }: { h: NonNullable<ScreenedData["byHourOfDay"]> }) {
  const [hover, setHover] = useState<number | null>(null);
  const clock = localClock();
  const shift = !h.timeZone || h.timeZone === "UTC" ? clock.offsetHours : 0;
  // Column i is local hour i, holding the API hour that falls on it.
  const hours = Array.from({ length: 24 }, (_, local) => {
    const from = (((local - shift) % 24) + 24) % 24;
    return { ...(h.hours[from] ?? h.hours[0]!), hour: local };
  });
  const total = hours.reduce((sum, x) => sum + x.calls, 0);
  if (h.days === 0 || total === 0) return null;
  const callsMax = Math.max(1, ...hours.map((x) => x.calls));
  const rateMax = Math.max(10, ...hours.map((x) => x.hit2xPct ?? 0));
  const top = Math.ceil(rateMax / 10) * 10;
  const retAbs = Math.max(5, ...hours.map((x) => Math.abs(x.avgReturnPct ?? 0)));
  const busiest = hours.reduce((b, x) => (x.calls > b.calls ? x : b), hours[0]!);
  const focus = hover !== null ? (hours[hover] ?? busiest) : busiest;
  const thin = (x: { graded: number }) => x.graded < MIN_HOUR_GRADED;
  const col = (x: { hour: number }, i: number) =>
    `${hover === i ? " is-hover" : ""}${thin(hours[i]!) ? " is-thin" : ""}`;
  const hoverProps = (i: number) => ({ onMouseEnter: () => setHover(i), onClick: () => setHover(i) });

  return (
    <div className="lh-hod" onMouseLeave={() => setHover(null)}>
      <h4 className="lh-subchart">
        By hour of the day in your local time ({clock.name}), all {h.days.toLocaleString()} days kept
      </h4>
      <p className="faint small">
        Every screened token in our history by the hour it was decided on, in your local time zone (
        {clock.name}): how many tokens each hour brings, how often they doubled, and what they returned on the
        exit plan. Hours with fewer than {MIN_HOUR_GRADED} graded tokens are faded. {RULE_NOTE_UNFILTERED}
      </p>
      <div className="lh-readout" aria-live="polite">
        <strong>
          {hourLabel(focus.hour, clock.minutes)}–{hourLabel(focus.hour + 1, clock.minutes)} {clock.name}
        </strong>
        <span className="num">{focus.calls.toLocaleString()} screened</span>
        <span className="lh-readout-item">
          <span className="lh-swatch lh-s1" />
          2x <span className="num">{pct(focus.hit2xPct, 1)}</span>
        </span>
        <span className="lh-readout-item">
          avg return <span className="num">{signedPct(focus.avgReturnPct, 1)}</span>
        </span>
        <span className="muted">
          {focus.graded.toLocaleString()} graded{thin(focus) ? " · too few to judge" : ""}
        </span>
      </div>
      <h5 className="lh-subchart">2x rate</h5>
      <div className="lh-rate-chart">
        <span className="lh-yaxis" aria-hidden>
          <span>{top}%</span>
          <span>{top / 2}%</span>
          <span>0%</span>
        </span>
        <div
          className="lh-groups"
          role="img"
          aria-label="2x rate of screened tokens by hour of the day, local time"
        >
          {hours.map((x, i) => (
            <div key={x.hour} className={`lh-group${col(x, i)}`} {...hoverProps(i)}>
              {x.hit2xPct !== null && (
                <span
                  className="lh-gbar lh-s1"
                  style={{ height: `${Math.max(0.5, (x.hit2xPct / top) * 100)}%` }}
                />
              )}
            </div>
          ))}
        </div>
      </div>
      <h5 className="lh-subchart">Average return</h5>
      <div className="lh-rate-chart">
        <span className="lh-yaxis" aria-hidden>
          <span>+{Math.round(retAbs)}%</span>
          <span>0%</span>
          <span>−{Math.round(retAbs)}%</span>
        </span>
        <div
          className="lh-ret"
          role="img"
          aria-label="Average exit-plan return of screened tokens by hour of the day, local time"
        >
          {hours.map((x, i) => {
            const v = x.avgReturnPct ?? 0;
            return (
              <div key={x.hour} className={`lh-ret-col${col(x, i)}`} {...hoverProps(i)}>
                {x.avgReturnPct !== null && (
                  <span
                    className={`lh-ret-bar ${v >= 0 ? "up" : "down"}`}
                    style={{ height: `${Math.max(0.5, (Math.abs(v) / retAbs) * 50)}%` }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
      <h5 className="lh-subchart">Tokens screened</h5>
      <div className="lh-rate-chart">
        <span className="lh-yaxis" aria-hidden>
          <span>{callsMax.toLocaleString()}</span>
          <span>{Math.round(callsMax / 2).toLocaleString()}</span>
          <span>0</span>
        </span>
        <div className="lh-groups" role="img" aria-label="Tokens screened by hour of the day, local time">
          {hours.map((x, i) => (
            <div key={x.hour} className={`lh-group${hover === i ? " is-hover" : ""}`} {...hoverProps(i)}>
              <span
                className="lh-gbar lh-other"
                style={{ height: `${Math.max(0.5, (x.calls / callsMax) * 100)}%` }}
              />
            </div>
          ))}
        </div>
      </div>
      <div className="lh-axis lh-axis-inset" aria-hidden>
        {hours.map((x) => (
          <span key={x.hour}>{x.hour % 3 === 0 ? `${x.hour}h` : ""}</span>
        ))}
      </div>
    </div>
  );
}

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
          <li>
            No more than {c.freshWalletMaxPct}% of the top 25 holders (the top 10 until those are read) on
            fresh wallets: first used, or used again after a week or more idle, in the last day.
          </li>
          <li>Under {c.emptyWalletRejectPct}% of the top 10 holders on otherwise empty wallets.</li>
          <li>
            Under {c.sniperWalletRejectPct ?? 80}% of the top 10 holders being the launch&apos;s first 25
            buyers.
          </li>
          <li>The top 10 holders own under {c.top10HolderRejectPct ?? 40}% of supply, pool aside.</li>
          <li>No single holder owns more than {c.largestHolderMaxPct ?? 10}% of supply, pool aside.</li>
          <li>
            Under {c.linkedRejectCount ?? 20} of the top 25 holders linked (one funder, funded each other, or
            funded the same minute).
          </li>
          <li>Under {c.cexFundedRejectCount ?? 21} of the top 25 holders funded from an exchange.</li>
          {(c.minPreBondSeconds ?? 5) > 0 && (
            <li>
              If graduated, its bonding curve took at least {c.minPreBondSeconds ?? 5}s to fill, so the launch
              wasn&apos;t bundled.
            </li>
          )}
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
          <li>
            Price not falling over the last 5 minutes
            {c.oldCoinMin5mPct !== undefined && c.oldCoinMinAgeMinutes !== undefined
              ? `, and up at least ${c.oldCoinMin5mPct}% once it is ${c.oldCoinMinAgeMinutes >= 60 ? `${c.oldCoinMinAgeMinutes / 60} hour${c.oldCoinMinAgeMinutes === 60 ? "" : "s"}` : `${c.oldCoinMinAgeMinutes} minutes`} old`
              : ""}
            .
          </li>
          <li>Holder wallet checks finished.</li>
        </ul>
      </div>
      <p className="faint small lh-checks-foot">
        Average return is what each token would have made on our fixed exit plan. {s.exitPlan}
      </p>
    </div>
  );
}
