import { useEffect, useRef } from "react";
import type { FeedStats, Leaderboard } from "../api";
import { RingGauge } from "./Charts";
import { FeedReturns } from "./FeedReturns";
import { MIN_RUNNERS_FOR_COVERAGE } from "./CoverageMeter";
import { BoltIcon, CheckIcon, CloseIcon, RadarIcon, TargetIcon, TrophyIcon } from "./Icons";
import { multiple, pct } from "../format";
import { usePolling } from "../hooks";
import { PAGE_DAYS } from "../tabs/modelShared";

/** Graded alerts below which a hit rate shows as "early" rather than as a verdict. */
const MIN_GRADED = 10;

/**
 * The Live tab's feed numbers (what the five tiles over the feed used to show), in a native modal
 * dialog: a centered panel on desktop, a sheet from the bottom on phones.
 */
export function FeedStatsModal({
  open,
  onClose,
  stats: fs,
  hours,
  targets: t,
  pollKey,
  highConviction,
}: {
  open: boolean;
  onClose: () => void;
  stats: FeedStats | null;
  hours: number;
  targets: { hitRate2xPct: number; hitRate4xPct: number };
  /** Changes when the feed's makeup does (the models it follows), so the returns refetch. */
  pollKey: string;
  /** The feed's model calls are the high-conviction tier alone (the Live tab's switch). */
  highConviction?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="about-modal sheet-modal stats-modal"
      aria-labelledby="feed-stats-title"
      onClose={onClose}
      // A click on the backdrop lands on the dialog element itself; clicks inside land on its content.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="about-body">
        <header className="about-head">
          <h2 id="feed-stats-title">Your feed · last {hours}h</h2>
          <button className="ghost icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon size={16} />
          </button>
        </header>
        {open && (
          <>
            <section className="kpis stats-grid">
              <div className="panel kpi stats-wide">
                <span className="eyebrow">
                  <RadarIcon size={13} /> Alerts · {hours}h
                </span>
                <span className="kpi-value num">{fs?.alerts ?? "–"}</span>
                <small className="muted">
                  {fs
                    ? fs.alerts === 0
                      ? "No alerts yet"
                      : fs.bothOnly
                        ? `Caught by both your filter and your models`
                        : `${fs.fromFilter} from your filter${fs.showModelAlerts ? `, ${fs.fromModels} model calls` : ""}`
                    : "Loading…"}
                </small>
                {fs && fs.pending > 0 && <small className="faint">{fs.pending} still grading</small>}
              </div>
              <div className="panel kpi kpi-ring">
                <RingGauge
                  label="Hit 2x within 15 min"
                  value={fs?.hit2xPct ?? null}
                  target={t.hitRate2xPct}
                  graded={fs?.graded ?? 0}
                  minGraded={MIN_GRADED}
                  series={1}
                />
              </div>
              <div className="panel kpi kpi-ring">
                <RingGauge
                  label="Hit 4x within 30 min"
                  value={fs?.hit4xPct ?? null}
                  target={t.hitRate4xPct}
                  graded={fs?.goalGraded ?? 0}
                  minGraded={MIN_GRADED}
                  series={2}
                />
              </div>
              <div className="panel kpi">
                <span className="eyebrow">
                  <TrophyIcon size={13} /> Hit 10x within 1 hr
                </span>
                <span className="kpi-value num">{fs?.hit10xPct != null ? pct(fs.hit10xPct, 1) : "–"}</span>
                <small className="muted">
                  {fs?.tenXGraded
                    ? `${fs.hit10x ?? 0} of ${fs.tenXGraded} settled alerts`
                    : "No settled alerts yet"}
                </small>
              </div>
              <div className="panel kpi">
                <span className="eyebrow">
                  <BoltIcon size={13} /> Best run · {hours}h
                </span>
                <span className="kpi-value num">{fs?.best ? multiple(fs.best.peakPct) : "–"}</span>
                <small className="muted">
                  {fs?.best ? (fs.best.symbol ? `$${fs.best.symbol}` : "unnamed token") : " "}
                </small>
                {fs?.medianPeakPct != null && (
                  <small className="faint">Typical alert peaked at {multiple(fs.medianPeakPct)}</small>
                )}
              </div>
            </section>
            <FeedCatchMeter pollKey={pollKey} />
            <p className="faint small stats-note">
              Coins alerted in your feed over the last {hours} hours, graded from the alert price. Alerts
              still being graded don&apos;t count as misses.
            </p>
            <FeedReturns pollKey={pollKey} highConviction={highConviction} />
          </>
        )}
      </div>
    </dialog>
  );
}

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

/** The catch goal when an older API build doesn't send one (as the Coverage Meter). */
const DEFAULT_GOAL_PCT = 75;

/**
 * The whole feed's catch: of the tokens that doubled over the Models tab's window, the share the
 * reader's models (the Coverage Meter's mix, while model alerts are on) and their switched-on
 * filters caught between them. The track shows the models' part and what the filters add on top.
 * Read from the Models tab's own board, so the models' part is the Coverage Meter's figure.
 */
function FeedCatchMeter({ pollKey }: { pollKey: string }) {
  const board = usePolling<Leaderboard>(`/curated/models?days=${PAGE_DAYS}`, 120_000, pollKey);
  const fc = board.data?.feedCatch;
  if (!fc) return null;
  const days = board.data!.window.days;
  const goal = board.data!.scoring.catchTargetPct ?? DEFAULT_GOAL_PCT;
  const share = (n: number) => (fc.runners > 0 ? Math.min(100, (n / fc.runners) * 100) : 0);
  const early = fc.runners < MIN_RUNNERS_FOR_COVERAGE;
  const onGoal = fc.pct !== null && fc.pct >= goal && !early;
  // Only alerts both caught: one fill, the runners a model and a filter both caught.
  const both = fc.bothOnly ?? false;
  const modelsPart = both ? share(fc.caught) : fc.models.count > 0 ? share(fc.models.caught) : 0;
  const filtersPart = !both && fc.filters.count > 0 ? share(fc.filters.only) : 0;
  const sources = [
    fc.models.count > 0 && plural(fc.models.count, "model"),
    fc.filters.count > 0 && plural(fc.filters.count, "filter"),
  ].filter(Boolean);
  const sentence =
    sources.length === 0
      ? "Your feed has no models or filters switched on."
      : fc.runners === 0
        ? `No runners in the last ${plural(days, "day")} yet.`
        : both
          ? `Your ${sources.join(" and ")} both caught ${fc.caught.toLocaleString()} of the ${plural(fc.runners, "runner")} (tokens that doubled) in the last ${plural(days, "day")}.`
          : `Your ${sources.join(" and ")} caught ${fc.caught.toLocaleString()} of the ${plural(fc.runners, "runner")} (tokens that doubled) in the last ${plural(days, "day")}.`;
  return (
    <div
      className="coverage feed-catch"
      title={`${sentence} A runner counts as caught when one of your models called it, ${both ? "and" : "or"} one of your filters alerted on it, at a moment that went on to double. Goal ${goal}%.`}
    >
      <div className="cov-head">
        <span className="cov-label">
          <TargetIcon size={13} /> Feed catch · {days}d
        </span>
        <span
          className={`cov-value num${early ? " early" : ""}`}
          role="meter"
          aria-label="Share of runners your feed caught"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={fc.pct ?? 0}
          aria-valuetext={fc.pct === null ? "no runners yet" : `${pct(fc.pct)} of runners caught`}
        >
          {fc.pct === null ? "–" : pct(fc.pct)}
        </span>
        <span className="cov-track" aria-hidden>
          {modelsPart > 0 && (
            <span className={`cov-fill${early ? " early" : ""}`} style={{ width: `${modelsPart}%` }} />
          )}
          {filtersPart > 0 && (
            <span
              className={`cov-fill filters${modelsPart > 0 ? " after" : ""}${early ? " early" : ""}`}
              style={{ left: `${modelsPart}%`, width: `${Math.min(filtersPart, 100 - modelsPart)}%` }}
            />
          )}
          <span className="cov-mark goal" style={{ left: `${Math.min(100, goal)}%` }} />
        </span>
        {onGoal ? (
          <span className="cov-badge">
            <CheckIcon size={12} /> On goal
          </span>
        ) : (
          <span className="cov-goal muted small num">goal {goal}%</span>
        )}
      </div>
      <p className="cov-note muted small">
        {sentence}
        {early && fc.runners > 0 && " Still early: too few runners to judge."}
      </p>
      {both && fc.runners > 0 && sources.length > 0 && (
        <p className="feed-catch-parts faint small">
          <span>
            <span className="feed-catch-key models" aria-hidden /> Both{" "}
            <span className="num">{pct(share(fc.caught))}</span>
          </span>
          <span>
            Models alone <span className="num">{pct(share(fc.models.caught))}</span>, filters alone{" "}
            <span className="num">{pct(share(fc.filters.caught))}</span>
          </span>
        </p>
      )}
      {!both && fc.runners > 0 && sources.length > 0 && (
        <p className="feed-catch-parts faint small">
          {fc.models.count > 0 && (
            <span>
              <span className="feed-catch-key models" aria-hidden /> Models{" "}
              <span className="num">{pct(share(fc.models.caught))}</span>
            </span>
          )}
          {fc.filters.count > 0 && (
            <span>
              <span className="feed-catch-key filters" aria-hidden />{" "}
              {fc.models.count > 0 ? (
                <>
                  Filters add <span className="num">{fc.filters.only.toLocaleString()}</span>{" "}
                  {fc.filters.only === 1 ? "runner" : "runners"} the models missed
                </>
              ) : (
                <>
                  Filters <span className="num">{pct(share(fc.filters.caught))}</span>
                </>
              )}
            </span>
          )}
        </p>
      )}
    </div>
  );
}
