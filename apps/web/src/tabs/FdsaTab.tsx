import { useState } from "react";
import { usePolling, useNow } from "../hooks";
import { ago, shortAddress } from "../format";
import { openTokenLink } from "../tradeLink";
import { AsOf } from "../components/AsOf";
import { HBarChart, MultiLines } from "../components/Charts";
import { RingGauge } from "../components/RingGauge";
import { Skeleton } from "../components/Skeleton";
import { TokenImage } from "../components/TokenImage";
import { ArrowRightIcon, BrainIcon, RadarIcon, RobotIcon, TargetIcon, FunnelIcon } from "../components/Icons";
import { pickHandlers, pointerX, useChartWidth } from "../components/useChartWidth";
import { tipCenter } from "../chartScale";
import {
  describeFdsaPlan,
  fdsaAxisTop,
  fdsaBankedMultiple,
  fdsaCheckInText,
  fdsaExitReasonText,
  fdsaHeld,
  fdsaLogPos,
  fdsaMultiple,
  fdsaSignedPct,
  type FdsaPlan,
  type FdsaRate,
} from "./fdsaView";

/**
 * FDSA for readers (user ask 2026-11-01: "make the FDSA page informational and user-facing"):
 * how Claude's paper desk is doing. Its P&L, its hit rate on the goal metric next to the pool's,
 * the funnel from every alert to a buy, its live and closed trades, and how its adaptive exits
 * played out against the default ladder.
 *
 * It opens at #fdsa for any reader with access, with no header link, nav entry or warm-up. It
 * reads GET /fdsa (apps/api/src/routes/fdsaPublic.ts), which carries no spend, models, reasoning
 * or controls: those are Admin > FDSA (AdminFdsa.tsx). Every figure is paper money, and the page
 * says so wherever a number could read as real.
 */

interface Fill {
  side: string;
  reason: string;
  multiple: number | null;
  sol: number;
  at: string;
}
interface Coin {
  mint: string;
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
}
interface OpenTrade extends Coin {
  id: string;
  openedAt: string;
  nowMultiple: number | null;
  peakMultiple: number | null;
  floorMultiple: number;
  soldFraction: number;
  planVersion: number;
  plan: FdsaPlan | null;
  buySol: number;
  backSol: number;
  fills: Fill[];
}
interface ClosedTrade extends Coin {
  id: string;
  openedAt: string;
  closedAt: string | null;
  holdMs: number;
  pnlSol: number;
  pnlPct: number | null;
  peakMultiple: number | null;
  planVersion: number;
  closeReason: string | null;
  hit2x: boolean | null;
  ladderReturnPct: number | null;
  fills: Fill[];
}
interface FdsaPage {
  computedAt?: string;
  days: number;
  status: { mode: "paper"; active: boolean; since: string; lastRunAt: string | null };
  bankroll: {
    startSol: number;
    equitySol: number;
    pnlSol: number;
    pnlPct: number | null;
    openValueSol: number;
    trades: number;
    closed: number;
    profitable: number;
    curve: { at: string; pnlSol: number }[];
  };
  record: { trades: FdsaRate; tradeVerdicts: FdsaRate; passes: FdsaRate; pool: FdsaRate; target: number };
  funnel: { screened: number; shortlisted: number; decided: number; bought: number; won: number };
  ladder: {
    summary: string;
    paired: number;
    fdsaAvgPct: number | null;
    ladderAvgPct: number | null;
    fdsaBetter: number;
  };
  exits: {
    hardFloorMultiple: number;
    byReason: { reason: string; count: number; avgMultiple: number | null }[];
    checkIns: { trigger: string; checks: number; changed: number }[];
  };
  open: OpenTrade[];
  closed: ClosedTrade[];
}

/** Under this many graded buys a rate is too noisy to call (the Models tab's rule of thumb). */
const MIN_GRADED = 30;
const WINDOWS = [7, 30, 90] as const;
/** The run chart shows this many of the latest closed trades: more and the bars turn to hairlines. */
const RUNS_SHOWN = 40;

const solText = (v: number, digits = 2) => `${v.toFixed(digits)} SOL`;
const signedSol = (v: number, digits = 2) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(digits)} SOL`;
const ratePct = (r: FdsaRate) => (r.rate === null ? null : r.rate * 100);
const coinLabel = (c: Coin) => c.symbol ?? shortAddress(c.mint);
const tone = (v: number | null | undefined) => (v === null || v === undefined ? "" : v >= 0 ? "good" : "bad");

export function FdsaTab() {
  const [days, setDays] = useState<(typeof WINDOWS)[number]>(30);
  const q = usePolling<FdsaPage>(`/fdsa?days=${days}`, 15_000);
  const now = useNow(30_000);
  if (!q.data) {
    if (q.error) return <p className="error">Couldn&apos;t load FDSA: {q.error.message}</p>;
    return (
      <div className="stack fdsa-page">
        <div className="panel">
          <Skeleton lines={4} height={18} />
        </div>
        <div className="panel">
          <Skeleton lines={8} />
        </div>
      </div>
    );
  }
  const d = q.data;
  return (
    <div className={`stack fdsa-page${q.stale ? " stale" : ""}`}>
      {q.error && <p className="error small">Refresh failed: {q.error.message}. Showing the last answer.</p>}
      <Hero d={d} days={days} setDays={setDays} now={now} />
      <Headline d={d} />
      <div className="columns even">
        <HitRatePanel d={d} />
        <FunnelPanel d={d} />
      </div>
      <PnlPanel d={d} />
      <LiveTrades trades={d.open} now={now} />
      <ExitsPanel d={d} />
      <ClosedTrades trades={d.closed} days={d.days} />
      <HowItWorks d={d} />
    </div>
  );
}

function Hero({
  d,
  days,
  setDays,
  now,
}: {
  d: FdsaPage;
  days: number;
  setDays: (v: (typeof WINDOWS)[number]) => void;
  now: number;
}) {
  const pnl = d.bankroll.pnlPct;
  return (
    <section className="panel hero fdsa-hero">
      <div className="hero-top">
        <div>
          <span className="eyebrow">
            <RobotIcon size={13} /> FDSA · Claude&apos;s paper trading desk
          </span>
          <h2 className="hero-title">
            {d.bankroll.trades === 0 ? (
              <>Waiting for its first trade</>
            ) : (
              <>
                <span className={pnl !== null && pnl < 0 ? "fdsa-down" : "grad"}>
                  {pnl === null
                    ? "Even"
                    : `${pnl >= 0 ? "Up" : "Down"} ${fdsaSignedPct(Math.abs(pnl)).slice(1)}`}
                </span>{" "}
                on {d.bankroll.trades} paper trade{d.bankroll.trades === 1 ? "" : "s"}
              </>
            )}
          </h2>
          <p className="muted">
            Claude reads every curated alert, shortlists the few worth a closer look, and decides whether to
            buy. On a buy it sets its own exit plan, then revisits that plan as the trade runs instead of
            selling on a fixed ladder. It trades paper money, with real prices and fees, and every trade is
            graded the same way as the rest of the site: a win is a 2x within 15 minutes of the alert, before
            a -50% stop.
          </p>
          <p className="fdsa-status small">
            <span className={`fdsa-pill ${d.status.active ? "on" : "off"}`}>
              <i aria-hidden="true" /> {d.status.active ? "Trading now" : "Paused"}
            </span>
            <span className="fdsa-pill paper">Paper money</span>
            <span className="faint">
              Bankroll since {new Date(d.status.since).toLocaleDateString()}
              {d.status.lastRunAt ? ` · checked ${ago(d.status.lastRunAt, now)}` : ""}
            </span>
          </p>
          <p>
            <AsOf computedAt={d.computedAt} now={now} />
          </p>
        </div>
        <div className="hero-actions">
          <div className="segmented small" role="radiogroup" aria-label="Window">
            {WINDOWS.map((w) => (
              <button
                key={w}
                type="button"
                role="radio"
                aria-checked={days === w}
                className={days === w ? "on" : ""}
                onClick={() => setDays(w)}
              >
                {w}d
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function Headline({ d }: { d: FdsaPage }) {
  const b = d.bankroll;
  const t = d.record.trades;
  const l = d.ladder;
  return (
    <div className="kpis fdsa-kpis">
      <div className="panel kpi">
        <span className="eyebrow">Paper P&amp;L</span>
        <span className={`kpi-value num ${tone(b.pnlSol)}`}>{signedSol(b.pnlSol)}</span>
        <span className="muted small">
          {fdsaSignedPct(b.pnlPct)} on a {solText(b.startSol, 0)} bankroll · now {solText(b.equitySol)}
        </span>
      </div>
      <div className="panel kpi">
        <span className="eyebrow">2x hit rate on its buys</span>
        <span className="kpi-value num">{t.rate === null ? "–" : `${Math.round(t.rate * 100)}%`}</span>
        <span className="muted small">
          {t.wins} of {t.graded} graded · target {Math.round(d.record.target * 100)}% · last {d.days}d
        </span>
      </div>
      <div className="panel kpi">
        <span className="eyebrow">Trades</span>
        <span className="kpi-value num">{b.trades}</span>
        <span className="muted small">
          {d.open.length} open · {b.closed} closed, {b.profitable} in profit
        </span>
      </div>
      <div className="panel kpi">
        <span className="eyebrow">Beat the fixed ladder</span>
        <span className="kpi-value num">{l.paired === 0 ? "–" : `${l.fdsaBetter}/${l.paired}`}</span>
        <span className="muted small">
          {l.paired === 0
            ? "No closed trade to compare yet"
            : `avg ${fdsaSignedPct(l.fdsaAvgPct)} vs the ladder's ${fdsaSignedPct(l.ladderAvgPct)}`}
        </span>
      </div>
    </div>
  );
}

function HitRatePanel({ d }: { d: FdsaPage }) {
  const r = d.record;
  const target = Math.round(r.target * 100);
  const lift =
    r.trades.rate !== null && r.pool.rate !== null && r.pool.rate > 0 ? r.trades.rate / r.pool.rate : null;
  return (
    <section className="panel">
      <span className="eyebrow">
        <TargetIcon size={13} /> Against the goal
      </span>
      <h3>Does it pick winners?</h3>
      <p className="muted small">
        The share of its buys that reached 2x within 15 minutes, next to every alert it read. The alerts are
        the bar to beat; the {target}% target is the aim.
      </p>
      <div className="fdsa-rings">
        <RingGauge
          label="Its buys"
          value={ratePct(r.trades)}
          target={target}
          graded={r.trades.graded}
          minGraded={MIN_GRADED}
        />
        <RingGauge
          label="Every alert it read"
          value={ratePct(r.pool)}
          target={target}
          graded={r.pool.graded}
          minGraded={MIN_GRADED}
          series={2}
        />
      </div>
      <p className="small">
        {r.trades.graded === 0
          ? "None of its buys has been graded yet."
          : lift === null
            ? `${r.trades.wins} of ${r.trades.graded} graded buys hit 2x.`
            : `Its buys hit 2x ${lift.toFixed(1)}× as often as the alerts it read (${r.trades.wins} of ${r.trades.graded}, against ${r.pool.wins} of ${r.pool.graded}).`}{" "}
        {r.trades.graded > 0 && r.trades.graded < MIN_GRADED && (
          <span className="faint">Too few graded buys to read much from yet.</span>
        )}
      </p>
      {r.trades.graded > 0 && (
        <p className="faint small">
          {r.trades.wins4x} of them went on to 4x within the hour. The alerts it passed on hit 2x{" "}
          {r.passes.rate === null ? "–" : `${Math.round(r.passes.rate * 100)}%`} of the time.
        </p>
      )}
    </section>
  );
}

function FunnelPanel({ d }: { d: FdsaPage }) {
  const f = d.funnel;
  const share = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "–");
  const stages = [
    { Icon: RadarIcon, title: "Read", count: f.screened, caption: "curated alerts" },
    {
      Icon: FunnelIcon,
      title: "Shortlisted",
      count: f.shortlisted,
      caption: `${share(f.shortlisted, f.screened)} of them`,
    },
    {
      Icon: BrainIcon,
      title: "Bought",
      count: f.bought,
      caption: `${share(f.bought, f.screened)} of every alert`,
    },
  ];
  return (
    <section className="panel">
      <span className="eyebrow">
        <FunnelIcon size={13} /> Last {d.days} days
      </span>
      <h3>From every alert to a buy</h3>
      <p className="muted small">
        A quick first read drops most alerts. The shortlist gets a full review, and only a few become trades.
      </p>
      <ol className="fdsa-funnel" aria-label="From every alert to a buy">
        {stages.map((s, i) => (
          <li key={s.title} style={{ width: `${100 - i * 14}%` }}>
            <span className="stage-icon">
              <s.Icon size={15} />
            </span>
            <span className="fdsa-funnel-title">{s.title}</span>
            <span className="fdsa-funnel-count num">{s.count.toLocaleString()}</span>
            <span className="faint small">{s.caption}</span>
          </li>
        ))}
        <li className="goal" style={{ width: "58%" }}>
          <span className="stage-icon">
            <TargetIcon size={15} />
          </span>
          <span className="fdsa-funnel-title">Hit 2x</span>
          <span className="fdsa-funnel-count num">{f.won.toLocaleString()}</span>
          <span className="faint small">of its graded buys</span>
        </li>
      </ol>
    </section>
  );
}

function PnlPanel({ d }: { d: FdsaPage }) {
  const b = d.bankroll;
  const curve = b.curve;
  // From zero at the reset, each closed trade, then today with the open trades marked to market.
  const points = [
    { label: "Start", pct: 0, sub: "fresh bankroll" },
    ...curve.map((p, i) => ({
      label: new Date(p.at).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      pct: b.startSol > 0 ? (p.pnlSol / b.startSol) * 100 : 0,
      sub: `after trade ${i + 1} · ${signedSol(p.pnlSol, 3)} closed`,
    })),
  ];
  if (d.open.length > 0 && b.pnlPct !== null)
    points.push({ label: "Now", pct: b.pnlPct, sub: `with ${d.open.length} open, marked at the last price` });
  return (
    <section className="panel">
      <header className="section-head">
        <div>
          <span className="eyebrow">Performance</span>
          <h3>Paper P&amp;L since the bankroll started</h3>
          <p className="muted small">
            Its running profit after each closed trade, as a share of the {solText(b.startSol, 0)} bankroll.
            Net of fees and a paper fill penalty, so it reads a little worse than the price did.
          </p>
        </div>
        <div className="fdsa-figure">
          <span className={`num ${tone(b.pnlSol)}`}>{fdsaSignedPct(b.pnlPct)}</span>
          <span className="faint small">{signedSol(b.pnlSol)}</span>
        </div>
      </header>
      {points.length < 2 ? (
        <p className="muted small fdsa-empty">The curve starts once its first trade closes.</p>
      ) : (
        <MultiLines
          labels={points.map((p) => p.label)}
          series={[{ key: "pnl", label: "P&L, % of bankroll", tone: "s1", values: points.map((p) => p.pct) }]}
          subs={points.map((p) => p.sub)}
          signed
          height={230}
        />
      )}
    </section>
  );
}

/**
 * One open trade on a log track from its -50% stop to above its high: the floor it can't sell
 * under, where it is now, its high, and the plan's take-profit marks still ahead.
 */
function LiveTrades({ trades, now }: { trades: OpenTrade[]; now: number }) {
  return (
    <section className="panel">
      <span className="eyebrow">
        <span className="fdsa-live-dot" aria-hidden="true" /> Live
      </span>
      <h3>Open trades</h3>
      <p className="muted small">
        Each bar runs from the -50% stop up. The shaded part is what the plan has locked in: everything still
        held sells if the price falls into it.
      </p>
      {trades.length === 0 ? (
        <p className="muted small fdsa-empty">Nothing open right now.</p>
      ) : (
        <div className="fdsa-trades">
          {trades.map((t) => (
            <LiveTrade key={t.id} t={t} now={now} />
          ))}
        </div>
      )}
    </section>
  );
}

function LiveTrade({ t, now }: { t: OpenTrade; now: number }) {
  const lo = 0.5;
  const partials = t.plan?.partials ?? [];
  const hi = fdsaAxisTop([t.peakMultiple, t.nowMultiple, 2, ...partials.map((p) => p.atMultiple)]);
  const at = (v: number) => `${(fdsaLogPos(v, lo, hi) * 100).toFixed(2)}%`;
  const nowM = t.nowMultiple ?? 1;
  const ticks = [0.5, 1, 2, 4, 10, 20, 50, 100].filter((v) => v <= hi);
  return (
    <article className="fdsa-trade">
      <header>
        <CoinBadge c={t} />
        <div className="fdsa-trade-now">
          <span className={`num ${tone(nowM - 1)}`}>{fdsaMultiple(t.nowMultiple)}</span>
          <span className="faint small">held {fdsaHeld(now - Date.parse(t.openedAt))}</span>
        </div>
      </header>
      <div
        className="fdsa-track"
        role="img"
        aria-label={`${coinLabel(t)}: now ${fdsaMultiple(nowM)}, high ${fdsaMultiple(t.peakMultiple)}, floor ${fdsaMultiple(t.floorMultiple)}`}
      >
        <div className="fdsa-track-rail" />
        <div className="fdsa-track-floor" style={{ width: at(t.floorMultiple) }} />
        {t.peakMultiple !== null && (
          <div
            className="fdsa-track-run"
            style={{
              left: at(Math.min(1, nowM)),
              width: `calc(${at(t.peakMultiple)} - ${at(Math.min(1, nowM))})`,
            }}
          />
        )}
        {partials.map((p) => (
          <span
            key={p.atMultiple}
            className={`fdsa-track-target${(t.peakMultiple ?? 0) >= p.atMultiple ? " done" : ""}`}
            style={{ left: at(p.atMultiple) }}
            title={`Sell ${Math.round(p.sellFraction * 100)}% at ${fdsaMultiple(p.atMultiple)}`}
          />
        ))}
        {t.peakMultiple !== null && (
          <span
            className="fdsa-track-peak"
            style={{ left: at(t.peakMultiple) }}
            title={`High ${fdsaMultiple(t.peakMultiple)}`}
          />
        )}
        <span className="fdsa-track-now" style={{ left: at(nowM) }} title={`Now ${fdsaMultiple(nowM)}`} />
        <div className="fdsa-track-ticks">
          {ticks.map((v) => (
            <span key={v} style={{ left: at(v) }}>
              {v}x
            </span>
          ))}
        </div>
      </div>
      <dl className="fdsa-trade-figs">
        <div>
          <dt>High</dt>
          <dd className="num">{fdsaMultiple(t.peakMultiple)}</dd>
        </div>
        <div>
          <dt>Floor</dt>
          <dd className="num">{fdsaMultiple(t.floorMultiple)}</dd>
        </div>
        <div>
          <dt>Sold</dt>
          <dd className="num">{Math.round(t.soldFraction * 100)}%</dd>
        </div>
        <div>
          <dt>Plan</dt>
          <dd className="num">v{t.planVersion}</dd>
        </div>
      </dl>
      <p className="faint small fdsa-plan-text">
        {t.plan ? describeFdsaPlan(t.plan) : "Running the -50% stop and its time limit."}
      </p>
    </article>
  );
}

function CoinBadge({ c, small = false }: { c: Coin; small?: boolean }) {
  const px = small ? 22 : 32;
  return (
    <button
      type="button"
      className={`fdsa-coin${small ? " small" : ""}`}
      onClick={() => openTokenLink(c.mint)}
      title={`${c.name ?? coinLabel(c)}: open the coin`}
    >
      <TokenImage
        url={c.imageUrl}
        mint={c.mint}
        size={px * 2}
        width={px}
        height={px}
        className="fdsa-coin-img"
        fallback={<span className="fdsa-coin-img fallback">{coinLabel(c).slice(0, 1)}</span>}
      />
      <span className="fdsa-coin-text">
        <strong>{coinLabel(c)}</strong>
        {!small && c.name && <span className="faint small">{c.name}</span>}
      </span>
    </button>
  );
}

function ExitsPanel({ d }: { d: FdsaPage }) {
  const runs = d.closed.slice(0, RUNS_SHOWN).reverse();
  const reasons = d.exits.byReason;
  const total = reasons.reduce((s, r) => s + r.count, 0);
  const checks = d.exits.checkIns.reduce((s, c) => s + c.checks, 0);
  const changed = d.exits.checkIns.reduce((s, c) => s + c.changed, 0);
  const l = d.ladder;
  return (
    <section className="panel">
      <span className="eyebrow">Adaptive exits</span>
      <h3>How its exits play out</h3>
      <p className="muted small">
        The default ladder sells set slices at 2x, 4x and 10x. FDSA instead sets a plan at entry and revisits
        it at milestones: crossing 2x, crossing 4x, a sharp drop from the high, and every 10 minutes it holds.
        It may lock in profit or tighten its stop, but it never loosens the -50% stop.
      </p>
      <h4 className="fdsa-sub">Each trade&apos;s high, and what it kept</h4>
      {runs.length === 0 ? (
        <p className="muted small fdsa-empty">No closed trades in the last {d.days} days.</p>
      ) : (
        <RunChart runs={runs} />
      )}
      <div className="columns even fdsa-exit-cols">
        <div>
          <h4 className="fdsa-sub">Why it sold</h4>
          {total === 0 ? (
            <p className="muted small">No sales yet.</p>
          ) : (
            <HBarChart
              data={reasons.map((r) => ({
                label: fdsaExitReasonText(r.reason),
                value: r.count,
                display: `${r.count} · ${Math.round((r.count / total) * 100)}%`,
                detail:
                  r.avgMultiple === null ? undefined : `sold at ${fdsaMultiple(r.avgMultiple)} on average`,
              }))}
            />
          )}
          {checks > 0 && (
            <p className="faint small">
              It revisited its plans {checks.toLocaleString()} time{checks === 1 ? "" : "s"} and changed them{" "}
              {changed.toLocaleString()} time{changed === 1 ? "" : "s"}:{" "}
              {d.exits.checkIns
                .map((c) => `${fdsaCheckInText(c.trigger).toLowerCase()} (${c.checks})`)
                .join(", ")}
              .
            </p>
          )}
        </div>
        <div>
          <h4 className="fdsa-sub">Against the fixed ladder, same alerts</h4>
          {l.paired === 0 ? (
            <p className="muted small">No closed trade has a ladder result to compare with yet.</p>
          ) : (
            <>
              <CompareBars fdsa={l.fdsaAvgPct} ladder={l.ladderAvgPct} />
              <p className="small">
                FDSA did better on <strong>{l.fdsaBetter}</strong> of {l.paired} trades.
              </p>
              <p className="faint small">
                Ladder: {l.summary.replace(/\.$/, "")}. Its result is from the alert price before costs, while
                FDSA&apos;s is from its own later fill after costs, so the comparison leans toward the ladder.
              </p>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/** Two average returns side by side on one signed scale: FDSA (slot 1) and the ladder (slot 2). */
function CompareBars({ fdsa, ladder }: { fdsa: number | null; ladder: number | null }) {
  const rows = [
    { key: "fdsa", label: "FDSA's exits", v: fdsa, cls: "s1" },
    { key: "ladder", label: "Fixed ladder", v: ladder, cls: "s2" },
  ];
  const span = Math.max(10, ...rows.map((r) => Math.abs(r.v ?? 0)));
  const hasNeg = rows.some((r) => (r.v ?? 0) < 0);
  const zero = hasNeg ? 50 : 0;
  return (
    <div className="fdsa-compare" role="table" aria-label="Average return per trade">
      {rows.map((r) => {
        const w = ((Math.abs(r.v ?? 0) / span) * (hasNeg ? 50 : 100)).toFixed(2);
        const left = (r.v ?? 0) >= 0 ? zero : zero - Number(w);
        return (
          <div className="fdsa-compare-row" role="row" key={r.key}>
            <span role="cell" className="fdsa-compare-label">
              <i className={`swatch ${r.cls}`} /> {r.label}
            </span>
            <span role="cell" className="fdsa-compare-track">
              {hasNeg && <i className="fdsa-compare-zero" style={{ left: "50%" }} />}
              <span className={`fdsa-compare-fill ${r.cls}`} style={{ left: `${left}%`, width: `${w}%` }} />
            </span>
            <span role="cell" className="num fdsa-compare-value">
              {fdsaSignedPct(r.v)}
            </span>
          </div>
        );
      })}
      <span className="faint small">Average return per trade</span>
    </div>
  );
}

/**
 * Each closed trade as a column on a log scale: a bar from where it bought (1x) to its high, and a
 * dot at what it kept (its return as a multiple). The gap between the two is what the exit left
 * on the table; a dot under 1x is a loss. Lines mark the -50% stop and 2x.
 */
function RunChart({ runs }: { runs: ClosedTrade[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [boxRef, width] = useChartWidth(640);
  const height = 240;
  const padL = 40;
  const padR = 10;
  const padT = 12;
  const padB = 22;
  const plotW = Math.max(10, width - padL - padR);
  const plotH = height - padT - padB;
  const kept = runs.map((r) => fdsaBankedMultiple(r.pnlPct));
  const lo = 0.4;
  const hi = fdsaAxisTop([...runs.map((r) => r.peakMultiple), ...kept, 2]);
  const y = (v: number) => padT + plotH - fdsaLogPos(v, lo, hi) * plotH;
  const slot = plotW / runs.length;
  const barW = Math.max(3, Math.min(14, slot * 0.5));
  const cx = (i: number) => padL + i * slot + slot / 2;
  const ticks = [0.5, 1, 2, 4, 10, 20, 50, 100].filter((v) => v <= hi);
  const pick = pickHandlers((e) => {
    const px = pointerX(e, width);
    if (px < padL || px > width - padR) return null;
    return Math.min(runs.length - 1, Math.max(0, Math.floor((px - padL) / slot)));
  }, setHover);
  const h = hover === null ? null : runs[hover];
  const hk = hover === null ? null : (kept[hover] ?? null);
  return (
    <figure className="chart">
      <div className="legend">
        <span className="key">
          <i className="swatch s1" /> High after buying
        </span>
        <span className="key">
          <i className="swatch s2 dot" /> What it kept
        </span>
        <span className="key faint">Last {runs.length} closed, oldest first</span>
      </div>
      <div className="chart-box" ref={boxRef}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          height={height}
          role="img"
          aria-label="Each closed trade's high and what it kept"
          {...pick}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line className={t === 1 ? "axis" : "grid"} x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} />
              <text className="tick" x={padL - 6} y={y(t) + 3} textAnchor="end">
                {t}x
              </text>
            </g>
          ))}
          <line className="fdsa-ref-stop" x1={padL} x2={width - padR} y1={y(0.5)} y2={y(0.5)} />
          <line className="fdsa-ref-goal" x1={padL} x2={width - padR} y1={y(2)} y2={y(2)} />
          {runs.map((r, i) => {
            const peak = Math.max(1, r.peakMultiple ?? 1);
            const k = kept[i] ?? null;
            const top = y(peak);
            const base = y(1);
            return (
              <g key={r.id} className={hover !== null && hover !== i ? "fdsa-dim" : undefined}>
                {base - top > 0.5 && (
                  <rect
                    className="fdsa-run"
                    x={cx(i) - barW / 2}
                    y={top}
                    width={barW}
                    height={base - top}
                    rx={Math.min(4, barW / 2)}
                  />
                )}
                {k !== null && (
                  <circle className="fdsa-kept" cx={cx(i)} cy={y(k)} r={hover === i ? 5.5 : 4} />
                )}
              </g>
            );
          })}
          <text className="tick fdsa-ref-label" x={width - padR} y={y(2) - 4} textAnchor="end">
            2x goal
          </text>
          <text className="tick fdsa-ref-label" x={width - padR} y={y(0.5) + 12} textAnchor="end">
            -50% stop
          </text>
        </svg>
        {h && (
          <div className="tooltip" style={{ left: `${(tipCenter(cx(hover!), width) / width) * 100}%` }}>
            <strong>{coinLabel(h)}</strong>
            <span>
              <i className="swatch s1" /> High {fdsaMultiple(h.peakMultiple)}
            </span>
            <span>
              <i className="swatch s2" /> Kept {fdsaMultiple(hk)} ({fdsaSignedPct(h.pnlPct)})
            </span>
            <span className="muted">
              {fdsaExitReasonText(h.closeReason)} · held {fdsaHeld(h.holdMs)}
            </span>
          </div>
        )}
      </div>
    </figure>
  );
}

function ClosedTrades({ trades, days }: { trades: ClosedTrade[]; days: number }) {
  return (
    <section className="panel">
      <span className="eyebrow">History</span>
      <h3>Closed trades</h3>
      <p className="muted small">
        The latest from the last {days} days. The result is what it banked on paper after fees. &ldquo;2x in
        15m&rdquo; is the alert&apos;s own grade, the same as on every other tab.
      </p>
      {trades.length === 0 ? (
        <p className="muted small fdsa-empty">No closed trades in the last {days} days.</p>
      ) : (
        <div className="table-wrap fdsa-table">
          <table>
            <thead>
              <tr>
                <th>Coin</th>
                <th>Result</th>
                <th>High</th>
                <th>Why it sold</th>
                <th>Held</th>
                <th>2x in 15m</th>
                <th>Ladder</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t.id}>
                  <td>
                    <CoinBadge c={t} small />
                  </td>
                  <td className={`num ${tone(t.pnlPct)}`}>
                    {fdsaSignedPct(t.pnlPct)}
                    <span className="faint small"> {signedSol(t.pnlSol, 3)}</span>
                  </td>
                  <td className="num">{fdsaMultiple(t.peakMultiple)}</td>
                  <td className="small">{fdsaExitReasonText(t.closeReason)}</td>
                  <td className="num">{fdsaHeld(t.holdMs)}</td>
                  <td>
                    {t.hit2x === null ? (
                      <span className="fdsa-grade muted">grading</span>
                    ) : t.hit2x ? (
                      <span className="fdsa-grade good">✓ yes</span>
                    ) : (
                      <span className="fdsa-grade bad">✗ no</span>
                    )}
                  </td>
                  <td className="num faint">{fdsaSignedPct(t.ladderReturnPct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function HowItWorks({ d }: { d: FdsaPage }) {
  const steps = [
    { title: "Read", text: "A fast first pass scores every curated alert and keeps about one in ten." },
    {
      title: "Decide",
      text: "A full review weighs the coin, its holders, its flow and how similar alerts went, then buys or passes.",
    },
    {
      title: "Plan",
      text: "A buy is a fixed 0.5 SOL with its own exit plan: a stop, floors to lock in, trailing exits and profit-taking.",
    },
    {
      title: "Adapt",
      text: "The plan runs on every price tick and is revisited at 2x, 4x, a sharp drop and every 10 minutes.",
    },
  ];
  return (
    <section className="panel">
      <span className="eyebrow">How it works</span>
      <h3>An AI desk with its own exits</h3>
      <ol className="pipeline fdsa-steps">
        {steps.map((s, i) => (
          <li className="stage" key={s.title}>
            <span className="stage-icon num">{i + 1}</span>
            <span className="stage-title">{s.title}</span>
            <span className="stage-caption">{s.text}</span>
            {i < steps.length - 1 && <ArrowRightIcon size={16} className="stage-arrow" />}
          </li>
        ))}
      </ol>
      <p className="faint small">
        Paper trading only: no real SOL is spent, but prices, fees and slippage are taken from the live
        market. Its stop never sits below -50% of what it paid ({fdsaMultiple(d.exits.hardFloorMultiple)}). A
        past hit rate is not a promise, and nothing here is financial advice.
      </p>
    </section>
  );
}
