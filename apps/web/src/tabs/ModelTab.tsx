import { useState, type ReactNode } from "react";
import {
  type EvolutionEvent,
  type GradedRates,
  type Leaderboard,
  type LeaderboardEntry,
  type ModelInsights,
  type FeatureHealthReport,
  type ModelRun,
  type LearningCurve,
  type LearningRates,
  type LearningTrend,
  type AiJudgeState,
  IN_SAMPLE_LABEL,
  runExamRates,
} from "../api";
import { HBarChart, MarkerBars, MultiLines, Skeleton, TargetBars } from "../components/Charts";
import {
  ArrowRightIcon,
  BrainIcon,
  ChartIcon,
  RadarIcon,
  RobotIcon,
  ShareIcon,
  TargetIcon,
} from "../components/Icons";
import { ShareImageDialog } from "../components/ShareImageDialog";
import { saveFeedSettings, toggledModels } from "../components/ModelPicker";
import { BAND_TONE, ScoreBar } from "../components/ScoreBar";
import { prefetch } from "../cache";
import { CURVE_SLICES } from "../cutoffCurve";
import { usePolling, useNow } from "../hooks";
import { GUEST_DELAY_MINUTES } from "../session";
import { ago, pct, signedPct, stakes, tokenLabel, usd } from "../format";
import {
  LEARNER_NAME,
  ROLE_LABEL,
  RulesInUse,
  STATUS_TEXT,
  PAGE_DAYS,
  WINDOWS,
  windowLong,
  windowShort,
  type WindowDays,
  doublings,
  bestReturnTitle,
  liftTone,
  profitTone,
  rateTitle,
  rateTone,
  recordSince,
  shortDate,
} from "./modelShared";
import { MIN_GRADED_FOR_RATE, RULE_NOTE, intervalText, isEarly, wilson, wilsonOfRate } from "../rates";
import { ModelDetailModal } from "./ModelDetail";
import { renderWeekCard, type WeekCardData } from "./weekCard";
import { DAY_MS, dayStarts, pricingChangePoint } from "../pricingChange";

/**
 * The Model tab: the curator contest. Several models train on the same graded history, each calls
 * on its own feed, a leaderboard ranks them on one composite score, and the Consensus learns from
 * the rest. The field evolves: each run breeds challengers from the leaders, and the best one
 * takes the weakest seat when it clearly out-examines it. The AI reviewer sits at the bottom, collapsed - it is a later focus.
 */
export function ModelTab({ guest = false }: { guest?: boolean }) {
  const now = useNow(60_000);
  const days = PAGE_DAYS;
  const [pick, setPick] = useState(0);
  // A guest reads the same reports from the read-only guest routes; the /curated ones need access.
  const api = guest ? "/guest" : "/curated";
  const insights = usePolling<ModelInsights>(`${api}/insights?days=${days}`, 120_000);
  const board = usePolling<Leaderboard>(`${api}/models?days=${days}`, 120_000, String(pick));

  const error = insights.error ?? board.error;
  if (error && (!insights.data || !board.data))
    return <p className="error">Couldn't load model data: {error.message}</p>;
  if (!insights.data || !board.data)
    return (
      <div className="stack">
        <div className="panel">
          <Skeleton lines={4} height={18} />
        </div>
        <div className="panel">
          <Skeleton lines={8} />
        </div>
      </div>
    );

  const data = insights.data;
  const lb = board.data;
  const t = lb.targets;
  // The leaderboard's baseline is the same market as the week chart's Market line and the lift
  // (safety cuts, current label rule); samples.byKind counts every banked row, so it is only the
  // stand-in for an older API build without one.
  const base = lb.baseline ?? data.samples.byKind.find((k) => k.kind === "event");
  const following = lb.entries.filter((e) => lb.selectedModels.includes(e.id));
  const consensus = lb.entries.find((e) => e.role === "stacked") ?? null;
  const contenders = lb.entries.filter((e) => e.role !== "stacked");
  // The board's order is vs market (hour-matched lift): its first row is "top by lift".
  const leader = lb.entries[0] ?? null;
  // "best" in the pipeline: the highest live 2x rate among seasoned models with enough graded calls.
  const bestContender = contenders
    .filter((e) => !e.composite.warmingUp && e.composite.live.graded >= MIN_GRADED_FOR_RATE)
    .sort((a, b) => (b.composite.live.winRatePct ?? -1) - (a.composite.live.winRatePct ?? -1))[0];
  // Same list, same save, as the Live tab's model checkboxes.
  const setFeedModels = async (models: string[] | null) => {
    if (guest) return;
    await saveFeedSettings({ models });
    setPick((n) => n + 1);
  };

  const trend = data.learning.trend;
  const leadLive = leader?.composite.live ?? null;
  const leadSince = leader ? recordSince(leader, lb) : null;
  // The headline: what the default feed itself delivered, pooled, with its interval. An older API
  // without the pooled record falls back to the top seat's own rate, labelled as such.
  const feed = lb.defaultFeed ?? null;
  const feedRate = feed && feed.graded > 0 ? (feed.wins / feed.graded) * 100 : null;
  const feedRange = feed ? wilson(feed.wins, feed.graded) : null;
  const feedRule4 = feed && feed.gradedRule4 > 0 ? (feed.winsRule4 / feed.gradedRule4) * 100 : null;
  const feedYoung = feed ? Date.parse(feed.since) > Date.parse(lb.window.since) + 3_600_000 : false;

  return (
    <div className="stack">
      <section className="panel hero">
        <div className="hero-top">
          <div>
            <span className="eyebrow">
              <BrainIcon size={13} /> {guest ? "The models" : "Your models"} at a glance
            </span>
            <h2 className="hero-title">
              {leader && leader.composite.score !== null ? (
                <>
                  <span className="grad">{leader.name}</span> is top by lift right now
                </>
              ) : (
                <>The models are still warming up</>
              )}
            </h2>
            <p className="muted">
              {lb.entries.length} models compete to spot tokens that double within 15 minutes. Every call is
              graded the same way, and the goal is a 2x within 15 minutes on {t.hitRate2xPct}% of calls and a
              4x within 30 minutes on {t.hitRate4xPct}%, with 10x within an hour on{" "}
              {lb.scoring.tenXTargetPct ?? 25}% as the big-run tier, while catching{" "}
              {lb.scoring.catchTargetPct ?? 75}% of all the tokens that double.{" "}
              {guest ? "As a guest you see calls from" : "Your feed shows calls from"}{" "}
              <strong>{following.map((e) => e.name).join(", ") || "–"}</strong>
              {lb.followBest ? " (whichever model is doing best; it switches automatically)" : ""}
              {guest
                ? `, ${GUEST_DELAY_MINUTES} minutes after each call. Connect a wallet to pick models`
                : ""}
              {lb.showModelAlerts ? "" : ", though model alerts are switched off on Live"}.
            </p>
          </div>
        </div>

        <div className="kpis glance">
          <div className="glance-tile">
            <label title="The board's order: its 2x rate over the market's in the same hours">
              Top by lift
            </label>
            <span className="glance-value">{leader?.name ?? "–"}</span>
            <span className="muted small">
              {leader?.vsMarket?.lift != null
                ? `${leader.vsMarket.lift.toFixed(1)}x the market's 2x rate in the hours it called`
                : "No lift yet"}
              {leadLive && leadLive.graded > 0
                ? ` · its own 2x ${pct(leadLive.winRatePct)} on ${leadLive.graded} graded${
                    leadSince ? ` since ${shortDate(leadSince)}` : ` in ${days} days`
                  }`
                : ""}
              {leader?.composite.score != null
                ? ` · rank score ${leader.composite.score.toFixed(0)} of 100${
                    leader.composite.band ? ` (${leader.composite.band.label.toLowerCase()})` : ""
                  }: how far it has proven itself toward the goal, not a rate`
                : ""}
            </span>
          </div>
          <div
            className="glance-tile"
            title={feed ? RULE_NOTE : rateTitle(leadLive?.winRatePct, leadLive?.graded ?? 0)}
          >
            <label>
              {feed
                ? `${guest ? "Guest" : "Default"} feed's calls that doubled`
                : `${leader?.name ?? "Top model"}'s calls that doubled`}
            </label>
            <span
              className={`glance-value num ${
                feed
                  ? rateTone(feedRate, t.hitRate2xPct, feed.graded)
                  : leadLive
                    ? rateTone(leadLive.winRatePct, t.hitRate2xPct, leadLive.graded)
                    : ""
              }`}
            >
              {pct(feed ? feedRate : leadLive?.winRatePct)}
            </span>
            <span className="muted small">
              {feed ? (
                <>
                  {feedRange ? `${intervalText(feedRange)} · ` : ""}
                  {feed.graded.toLocaleString()} graded calls{" "}
                  {feedYoung ? `since ${shortDate(feed.since)}` : `in ${days} days`}, each token once · goal{" "}
                  {t.hitRate2xPct}%
                  {feedRule4 !== null
                    ? ` · rule 4 alone: ${pct(feedRule4)} of ${feed.gradedRule4.toLocaleString()}`
                    : ""}
                  {feed.fallbackSlots > 0
                    ? ` · ${feed.fallbackSlots} slot${feed.fallbackSlots === 1 ? "" : "s"} on the single champion not counted`
                    : ""}
                  {!guest && !lb.followsDefault ? " · your feed follows your own picks" : ""}
                </>
              ) : (
                <>
                  {leadLive && leadLive.graded > 0
                    ? `${intervalText(wilsonOfRate(leadLive.winRatePct, leadLive.graded))} · `
                    : ""}
                  Goal {t.hitRate2xPct}%
                  {leadLive
                    ? ` · ${leadLive.graded} graded calls${leadSince ? ` since ${shortDate(leadSince)}` : ` in ${days} days`}`
                    : ""}
                </>
              )}
            </span>
          </div>
          <div className="glance-tile">
            <label>Getting better?</label>
            <span className={`glance-value state ${trend ? TREND_STATE[trend.verdict] : "early"}`}>
              {trend ? TREND_TEXT[trend.verdict] : TREND_TEXT["too-early"]}
            </span>
            <span className="muted small">
              {trend?.recent.lift2x != null
                ? `Lately the models' picks double ${trend.recent.lift2x.toFixed(1)}x as often as the average token they could have picked${
                    trend.prior?.lift2x != null ? ` (${trend.prior.lift2x.toFixed(1)}x before)` : ""
                  }.`
                : "Needs a few days of graded calls to tell."}
            </span>
          </div>
        </div>
        <p className="faint small rule-note">
          {RULE_NOTE} Ranges are 90% Wilson intervals; rates on fewer than {MIN_GRADED_FOR_RATE} graded calls
          are muted as early.
        </p>
      </section>

      <BaselinePanel
        board={lb}
        base={base ?? null}
        runs={data.runs}
        api={api}
        guest={guest}
        now={now}
        onSetModels={setFeedModels}
        refreshing={board.stale}
        refreshKey={String(pick)}
      />

      <WeekPanel learning={data.learning} board={lb} now={now} />

      <WinnerRunsPanel data={data} days={days} />

      <UnderTheHood>
        <LeaderboardPanel
          board={lb}
          days={days}
          onSetModels={setFeedModels}
          guest={guest}
          refreshing={board.stale}
          now={now}
        />

        <section className="panel">
          <span className="eyebrow">The contest</span>
          <h3>How a call is made</h3>
          <p className="muted small">
            Each model trains on the same graded history every few hours, makes its own calls on its own feed,
            and is graded the same way: {data.rules.win}. The field evolves: every run breeds new variants of
            the leaders, and a variant that clearly beats the weakest model takes its seat. The{" "}
            <strong>Consensus</strong> doesn&apos;t read the market directly; it learns how far to trust each
            of the others.
          </p>
          <ol className="pipeline" aria-label="How a call is made">
            <PipelineStage
              Icon={RadarIcon}
              title="Scanner"
              caption="decision moments"
              count={base?.calls}
              rate={base?.hitRate2xPct}
            />
            <PipelineStage
              Icon={BrainIcon}
              title={`${contenders.length} models`}
              caption={
                bestContender
                  ? `best 2x (${MIN_GRADED_FOR_RATE}+ graded): ${bestContender.name}`
                  : `none with ${MIN_GRADED_FOR_RATE}+ graded yet`
              }
              count={undefined}
              rate={bestContender?.composite.live.winRatePct}
            />
            <PipelineStage
              Icon={BrainIcon}
              title="Consensus"
              caption="calls"
              count={consensus?.composite.live.calls}
              rate={consensus?.composite.live.winRatePct}
            />
            <li className="stage goal">
              <span className="stage-icon">
                <TargetIcon size={16} />
              </span>
              <span className="stage-title">Goal</span>
              <span className="stage-rate num">{t.hitRate2xPct}%</span>
              <span className="stage-caption">
                hit 2x · {t.hitRate4xPct}% hit 4x · {lb.scoring.tenXTargetPct ?? 25}% hit 10x ·{" "}
                {lb.scoring.catchTargetPct ?? 75}% of runners caught
              </span>
            </li>
          </ol>
          <p className="faint small">
            Live 2x rate over the last {days} days at each step. Entry: {data.rules.fill}. {RULE_NOTE}
          </p>
        </section>

        <LeaderboardPanel
          board={lb}
          days={days}
          onSetModels={setFeedModels}
          guest={guest}
          refreshing={board.stale}
          now={now}
          detailed
        />

        <HowItWorks board={lb} />

        <EvolutionPanel board={lb} now={now} />

        <TrainingPanel runs={data.runs} board={lb} targets={t} now={now} />

        <div className="columns even">
          <section className="panel">
            <span className="eyebrow">Signals</span>
            <h3>What the models look at</h3>
            {data.importance && data.importance.features.length > 0 ? (
              <>
                <p className="muted small">
                  {runName(data.runs.find((r) => r.id === data.importance!.modelId)) ??
                    LEARNER_NAME[data.importance.learner]}{" "}
                  {data.importance.learner !== "logistic"
                    ? "- share of tree splits that use each signal."
                    : "- share of standardized weight; ▲ more is better, ▼ less is better."}
                </p>
                <HBarChart
                  data={data.importance.features.map((f) => ({
                    label: `${f.direction === 1 ? "▲ " : f.direction === -1 ? "▼ " : ""}${f.label}`,
                    value: f.sharePct,
                    display: `${f.sharePct.toFixed(1)}%`,
                  }))}
                />
              </>
            ) : (
              <p className="empty">Appears after the first training run.</p>
            )}
          </section>

          <FeatureHealthPanel data={data} now={now} />
        </div>

        <AiReviewerPanel data={data} now={now} />
      </UnderTheHood>
    </div>
  );
}

/**
 * Every model's hit rate against the baseline: the rate of the decision moments the models pick
 * from (the "event" training rows past the wallet safety cuts and graded under the current label
 * rule: the leaderboard's baseline, GET /curated/models, the same market as the lift). A model is only adding
 * anything above that line, so it sits up front, as a chart with the baseline drawn through it.
 * The population is fixed in the worker: a moment is banked only after the safety screen passes
 * (scanJob.ts returns before sampling on a fail) and the event pre-check (passesEventPreGate in
 * packages/core curator.ts) - and the curators decide only at those same moments.
 */
type BaselineProps = {
  board: Leaderboard;
  base: GradedRates | null;
  runs: ModelRun[];
  api: string;
  guest: boolean;
  now: number;
  onSetModels: (models: string[] | null) => Promise<void>;
  refreshing: boolean;
  /** Bumped when the feed's picks change, so the 24h board refetches like the page's does. */
  refreshKey: string;
};

/** The chart's measures: the three hit rates, and the share of the runners caught. */
type BaselineMetric = "2x" | "4x" | "10x" | "caught";
const BASELINE_METRICS: readonly { id: BaselineMetric; label: string }[] = [
  { id: "2x", label: "2x" },
  { id: "4x", label: "4x" },
  { id: "10x", label: "10x" },
  { id: "caught", label: "Caught" },
];

type BaselineView = {
  days: WindowDays;
  setDays: (d: WindowDays) => void;
  metric: BaselineMetric;
  setMetric: (m: BaselineMetric) => void;
  picked: string | null;
  setPicked: (id: string | null) => void;
  opened: string | null;
  setOpened: (id: string | null) => void;
};

function BaselinePanel(props: BaselineProps) {
  const [days, setDays] = useState<WindowDays>(PAGE_DAYS);
  const [metric, setMetric] = useState<BaselineMetric>("2x");
  const [picked, setPicked] = useState<string | null>(null);
  // The model whose detail dialog is open (it follows the board, so a window switch refreshes it).
  const [opened, setOpened] = useState<string | null>(null);
  const view = { days, setDays, metric, setMetric, picked, setPicked, opened, setOpened };
  // The page's own board is the 7-day one; the 24h board is polled only while it is picked.
  return days === PAGE_DAYS ? (
    <BaselineChart {...props} {...view} loading={false} />
  ) : (
    <DayBaselineChart {...props} {...view} />
  );
}

/** The chart over a window the page doesn't load itself; the page's bars stay up, dimmed, until it lands. */
function DayBaselineChart(props: BaselineProps & BaselineView) {
  const own = usePolling<Leaderboard>(`${props.api}/models?days=${props.days}`, 120_000, props.refreshKey);
  return (
    <BaselineChart
      {...props}
      board={own.data ?? props.board}
      base={own.data ? (own.data.baseline ?? null) : props.base}
      loading={own.data === null || own.stale}
      // The 7-day bars stand in only while this window loads: under a failed load they would read
      // as this window's numbers.
      failed={own.data === null && own.error !== null}
      refreshing={props.refreshing || own.stale}
    />
  );
}

function BaselineChart({
  board,
  base,
  runs,
  api,
  guest,
  now,
  onSetModels,
  refreshing,
  days,
  setDays,
  metric,
  setMetric,
  picked,
  setPicked,
  opened,
  setOpened,
  loading,
  failed = false,
}: BaselineProps & BaselineView & { loading: boolean; failed?: boolean }) {
  const t = board.targets;
  const caught = metric === "caught";
  // The catch rate has no random-pick baseline (a random picker's share of the runners only grows
  // with how many it calls), so its reference line is the whole field's: the runners any model caught.
  const field = board.runners ?? null;
  const baseRate = caught
    ? (field?.pct ?? null)
    : base
      ? metric === "2x"
        ? base.hitRate2xPct
        : metric === "4x"
          ? base.hitRate4xPct
          : (base.hitRate10xPct ?? null)
      : null;
  const goal =
    metric === "2x"
      ? t.hitRate2xPct
      : metric === "4x"
        ? t.hitRate4xPct
        : metric === "10x"
          ? (board.scoring.tenXTargetPct ?? 25)
          : (board.scoring.catchTargetPct ?? 75);
  const rateOf = (e: LeaderboardEntry) =>
    metric === "2x"
      ? e.composite.live.winRatePct
      : metric === "4x"
        ? e.composite.live.goalRatePct
        : metric === "10x"
          ? (e.composite.live.tenXRatePct ?? null)
          : (e.liveCatch?.pct ?? null);
  // Seasoned records first: a 33% on three calls shouldn't sit above a 15% on a hundred.
  const thin = (e: LeaderboardEntry) => e.composite.warmingUp === true || isEarly(e.composite.live.graded);
  const rows = [...board.entries].sort(
    (a, b) => Number(thin(a)) - Number(thin(b)) || (rateOf(b) ?? -1) - (rateOf(a) ?? -1),
  );
  // Until the reader picks, the readout narrates their own feed's first model (the guest feed's
  // for a guest), else the board's leader - not whichever bar happens to be tallest.
  const selected =
    rows.find((e) => e.id === picked) ??
    board.entries.find((e) => board.selectedModels.includes(e.id)) ??
    board.entries[0] ??
    null;
  const selRate = selected ? rateOf(selected) : null;
  // The 2x lift is the board's own, hour-matched over the hours the model called (its "vs market"),
  // so the same model reads the same lift here as in the leaderboard. The 4x and 10x have no
  // hour-matched market, so they are read against the window's baseline without a multiple.
  const selLift = metric === "2x" ? (selected?.vsMarket?.lift ?? null) : null;
  const selMarket = metric === "2x" ? (selected?.vsMarket?.marketRatePct ?? null) : null;
  const selGraded = selected?.composite.live.graded ?? 0;
  const selSince = selected ? recordSince(selected, board) : null;
  const hit =
    metric === "4x"
      ? "reached 4x within 30 minutes"
      : metric === "10x"
        ? "reached 10x within an hour"
        : "doubled within 15 minutes";
  const selCatch = selected?.liveCatch ?? null;

  return (
    <section className={`panel${loading ? " stale" : ""}`} aria-busy={loading}>
      <header className="section-head">
        <div>
          <span className="eyebrow">
            <TargetIcon size={13} /> Models vs baseline
          </span>
          <h3>Are the models beating a random pick?</h3>
          <p className="muted small">
            {caught ? (
              <>
                Of the tokens that doubled cleanly, the share each model called at a winning moment: the
                runners it didn&apos;t let slip. The line is every model together; the goal is {goal}% of the
                runners.
              </>
            ) : (
              <>
                The baseline is how often a token {hit} if you picked at random from the same moments the
                models choose from. A model is only adding value to the right of that line.
              </>
            )}
          </p>
        </div>
        <div className="row baseline-controls">
          <div className="segmented small" role="tablist" aria-label="Window">
            {WINDOWS.map((w) => (
              <button
                key={w}
                role="tab"
                aria-selected={w === days}
                className={w === days ? "on" : ""}
                onPointerEnter={() => {
                  if (w !== PAGE_DAYS) prefetch(`${api}/models?days=${w}`);
                }}
                onClick={() => setDays(w)}
              >
                {windowShort(w)}
              </button>
            ))}
          </div>
          <div className="segmented small" role="group" aria-label="Measure">
            {BASELINE_METRICS.map((m) => (
              <button
                key={m.id}
                className={metric === m.id ? "on" : ""}
                aria-pressed={metric === m.id}
                title={m.id === "caught" ? "Share of the runners each model called" : undefined}
                onClick={() => setMetric(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {failed && (
        <p className="error">Couldn&apos;t load the last {windowLong(days)}. It will try again shortly.</p>
      )}
      {!failed && (
        <>
          <div className="family-figs">
            <div>
              <label>{caught ? "All models caught" : `Baseline ${metric}`}</label>
              <span className="num">{pct(baseRate, 1)}</span>
            </div>
            <div>
              <label>{caught ? "Runners" : "Moments it covers"}</label>
              <span className="num">
                {caught
                  ? field
                    ? field.runners.toLocaleString()
                    : "–"
                  : base
                    ? base.graded.toLocaleString()
                    : "–"}
              </span>
            </div>
            <div>
              <label>Goal</label>
              <span className="num">{goal}%</span>
            </div>
          </div>

          {rows.length > 0 ? (
            <>
              <MarkerBars
                data={rows.map((e) => {
                  const rate = rateOf(e);
                  const profit = e.composite.live.avgSimReturnPct ?? null;
                  return {
                    id: e.id,
                    label: e.name,
                    value: rate,
                    sub:
                      caught && e.liveCatch
                        ? `${e.liveCatch.caught} of ${e.liveCatch.runners} runner${e.liveCatch.runners === 1 ? "" : "s"}`
                        : `${e.composite.live.graded} graded call${e.composite.live.graded === 1 ? "" : "s"}`,
                    display: rate === null ? "–" : `${rate.toFixed(1)}%`,
                    note: `${signedPct(profit)} profit`,
                    noteTone: profit === null || profit === 0 ? undefined : profit > 0 ? "up" : "down",
                    thin: thin(e),
                  };
                })}
                markers={[
                  ...(baseRate !== null
                    ? [{ label: caught ? "All models" : "Baseline", value: baseRate, kind: "base" as const }]
                    : []),
                  { label: "Goal", value: goal, kind: "goal" as const },
                ]}
                selected={selected?.id ?? null}
                onSelect={setPicked}
                onOpen={setOpened}
                columns={{
                  label: "Model",
                  value: caught ? "runners caught" : `${metric} hit rate`,
                  note: "avg profit per call",
                }}
              />
              {selected && (
                <p className="baseline-readout">
                  <strong>{selected.name}</strong>:{" "}
                  {caught
                    ? selCatch === null || selCatch.runners === 0 || selRate === null
                      ? `no runners since it started calling in the last ${windowLong(days)} yet.`
                      : `called ${selCatch.caught} of the ${selCatch.runners} tokens that doubled since it started calling in the last ${windowLong(days)}, ${pct(selRate, 1)} of the runners against the ${goal}% goal${
                          baseRate === null ? "." : ` (every model together: ${pct(baseRate, 1)}).`
                        }`
                    : selRate === null
                      ? `no graded calls in the last ${windowLong(days)} yet.`
                      : `${pct(selRate, 1)} of its ${selGraded} graded calls${
                          selSince ? ` since ${shortDate(selSince)}` : ""
                        } ${hit} (${intervalText(wilsonOfRate(selRate, selGraded))})${
                          metric !== "2x"
                            ? baseRate === null
                              ? "."
                              : `, against the baseline's ${pct(baseRate, 1)}.`
                            : selLift === null
                              ? "."
                              : selLift >= 1
                                ? `, ${selLift.toFixed(1)}x the market's ${pct(selMarket, 1)} in the hours it called.`
                                : `, below the market's ${pct(selMarket, 1)} in the hours it called: worse than picking at random.`
                        }`}
                  {selected.composite.live.avgSimReturnPct != null
                    ? ` Following every call averaged ${signedPct(selected.composite.live.avgSimReturnPct)} a call.`
                    : ""}
                  {selected.composite.warmingUp || isEarly(selGraded)
                    ? " Still too few calls to lean on."
                    : ""}
                </p>
              )}
              <p className="faint small">
                Live calls over the last {windowLong(days)}, against{" "}
                {caught ? "every model's catch together" : "the baseline"} over the same window. Under each
                rate is its average profit per call, following every call with one fixed exit plan. Faded bars
                rest on too few calls. <strong>Tap or click a model</strong> for its full record, past
                versions and exam results. {RULE_NOTE}
              </p>
              <ModelDetailModal
                entry={board.entries.find((e) => e.id === opened) ?? null}
                board={board}
                base={base}
                runs={runs}
                days={days}
                api={api}
                guest={guest}
                now={now}
                onClose={() => setOpened(null)}
                onSetModels={onSetModels}
                refreshing={refreshing}
              />
            </>
          ) : (
            <p className="empty">No models on the board yet.</p>
          )}
        </>
      )}

      <details className="folds">
        <summary>What exactly is the baseline?</summary>
        <p className="muted small">
          It is measured <strong>after</strong> the safety screen and the pre-check, and{" "}
          <strong>before</strong> any model or your own filters. A token only becomes a baseline moment once
          it gets through every one of these, in order:
        </p>
        <ol className="baseline-steps">
          <li>
            <strong>Seen by the scanner</strong> on Pump.fun and priced.
          </li>
          <li>
            <strong>Passes the safety screen</strong>: mint and freeze authority renounced, liquidity burned
            or locked, not a Mayhem Mode token, no more than 70% of the top 10 holders on fresh wallets, under
            80% on empty wallets or launch snipers, the top 10 owning under 40% of supply, no single holder
            over 10%, under 20 of the top 25 holders linked and under 17 funded from an exchange, and a
            bonding curve that took at least 5 seconds to fill. A token that fails is never sampled at all.
          </li>
          <li>
            <strong>Passes the pre-check</strong>: market cap inside the scanner&apos;s band ($10k to $1M),
            under 6 hours old, buyers making at least 55% of the last hour&apos;s trades, price not falling
            over the last 5 minutes, and the fresh and empty wallet checks done.
          </li>
          <li>
            <strong>First time per token per hour</strong>: only the first moment a token passes counts, so a
            token that hovers near the line isn&apos;t counted over and over.
          </li>
        </ol>
        <p className="muted small">
          Those moments are exactly where the models decide, so the comparison is like for like: same tokens,
          same moment, same grading ({hit}, from the price at that moment, with a 50% drop first counting as a
          loss). Your own filter settings (minimum market cap, wallet caps and the rest) play no part in it.
          It is also not a raw average of every Pump.fun token: tokens the screen or pre-check turn away never
          count, for or against.
        </p>
      </details>
    </section>
  );
}

/** How many runner traits the winners panel lists. */
const RUNNER_TRAIT_ROWS = 4;

/**
 * How far the winners went after the call. A call that doubles inside 15 minutes stays on watch
 * for a day, and its run peak shows whether the models are finding doubles or real runners -
 * plus, from the newest training run, which signals the biggest runners shared.
 */
function WinnerRunsPanel({ data, days }: { data: ModelInsights; days: number }) {
  const runs = data.winnerRuns ?? [];
  const feed = runs.find((r) => r.population === "curated") ?? null;
  const samples = runs.find((r) => r.population === "samples") ?? null;
  const traits = data.runnerTraits ?? null;
  const shown = feed && feed.finished > 0 ? feed : samples;
  const mult = (v: number | null | undefined) => (v == null ? "–" : `${v.toFixed(1)}x`);
  const minutes = (v: number | null | undefined) =>
    v == null ? "–" : v >= 90 ? `${(v / 60).toFixed(1)}h` : `${Math.round(v)} min`;
  return (
    <section className="panel">
      <span className="eyebrow">After the win</span>
      <h3>How far the winners ran</h3>
      <p className="muted small">
        Every call that doubles inside 15 minutes is watched for another day to see how high it goes.
        {shown === samples && samples
          ? " The models have no finished runs yet in this window, so these are all the winning moments the models learn from."
          : ` All models' winners over the last ${days} days, every model's calls pooled, not just your feed's.`}{" "}
        The 4x and 10x figures are shares of those winners, by their peak within 24 hours, not hit rates.
      </p>
      {shown && shown.finished > 0 ? (
        <div className="family-figs">
          <div>
            <label>Typical run</label>
            <span className="num">{mult(shown.medianPeakMultiple)}</span>
          </div>
          <div>
            <label>Of winners, 4x peak within 24h</label>
            <span className="num">{pct(shown.reached4xPct, 0)}</span>
          </div>
          <div>
            <label>Of winners, 10x peak within 24h</label>
            <span className="num">{pct(shown.reached10xPct, 0)}</span>
          </div>
          <div>
            <label>Best</label>
            <span className="num">{mult(shown.bestPeakMultiple)}</span>
          </div>
          <div>
            <label>Peak came after</label>
            <span className="num">{minutes(shown.medianMinutesToPeak)}</span>
          </div>
        </div>
      ) : (
        <p className="empty">
          {shown && shown.winners > 0
            ? `${shown.winners} winner${shown.winners === 1 ? "" : "s"} still being watched.`
            : "No winners to follow in this window yet."}
        </p>
      )}
      {traits && traits.traits.length > 0 && traits.bigRunnerMultiple !== null && (
        <>
          <p className="muted small">
            What the biggest runners had in common (the top quarter of {traits.winners.toLocaleString()}{" "}
            winners, each of which ran to {mult(traits.bigRunnerMultiple)} or more). Lift is how much more
            often a winner with the signal high (or low) became one of them; 1 is no difference.
          </p>
          <div
            className="table-wrap"
            tabIndex={0}
            role="region"
            aria-label="What the biggest runners had in common"
          >
            <table className="compact">
              <thead>
                <tr>
                  <th>Signal</th>
                  <th className="r">When high</th>
                  <th className="r">When low</th>
                </tr>
              </thead>
              <tbody>
                {traits.traits.slice(0, RUNNER_TRAIT_ROWS).map((f) => (
                  <tr key={f.feature}>
                    <td>{f.label}</td>
                    <td className="r num">{f.topThirdLift.toFixed(2)}x</td>
                    <td className="r num">{f.bottomThirdLift.toFixed(2)}x</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

const HOOD_KEY = "ts.model.underTheHood";

/**
 * The details most people don't need: collapsed by default, remembered per browser, and only
 * rendered once opened so the closed tab stays light.
 */
function UnderTheHood({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(HOOD_KEY) === "1";
    } catch {
      return false;
    }
  });
  return (
    <details
      className="under-hood"
      open={open}
      onToggle={(e) => {
        const next = (e.target as HTMLDetailsElement).open;
        setOpen(next);
        try {
          localStorage.setItem(HOOD_KEY, next ? "1" : "0");
        } catch {
          // Private mode: the section just starts closed next time.
        }
      }}
    >
      <summary className="panel under-hood-summary">
        <span>
          <strong>Under the hood</strong>
          <span className="muted small">
            The leaderboard and every figure behind it, how scores and profit are worked out, training exams,
            evolution, the signals the models read, and the AI reviewer.
          </span>
        </span>
        <span className="under-hood-toggle small">{open ? "Hide" : "Show"}</span>
      </summary>
      {open && <div className="stack">{children}</div>}
    </details>
  );
}

function runName(run: ModelRun | undefined): string | null {
  return run?.contestantName ?? null;
}

/** How many signals the health panel lists at each end. */
const HEALTH_ROWS = 6;

/**
 * The inputs' health from the newest training run: which signals are mostly missing (a wire
 * that has come loose), and which carry the most signal on their own; plus the data-continuity
 * line - when the newest training sample was banked.
 */
function FeatureHealthPanel({ data, now }: { data: ModelInsights; now: number }) {
  const health = data.featureHealth ?? null;
  const held = data.heldFeatures ?? [];
  const newest = data.samples.newestAnchorAt ? new Date(data.samples.newestAnchorAt).getTime() : null;
  const stale = newest !== null && now - newest > 30 * 60_000;
  const mostlyNull = health
    ? health.features.filter((f) => f.nullRatePct >= 50).sort((a, b) => b.nullRatePct - a.nullRatePct)
    : [];
  const lift = (f: FeatureHealthReport["features"][number]) =>
    Math.max(f.topDecileLift ?? 0, f.bottomDecileLift ?? 0);
  const strongest = health
    ? health.features
        .filter((f) => f.topDecileLift !== null)
        .sort((a, b) => lift(b) - lift(a))
        .slice(0, HEALTH_ROWS)
    : [];
  return (
    <section className="panel">
      <span className="eyebrow">Inputs</span>
      <h3>Signal health</h3>
      <p className={`small ${stale || newest === null ? "bad" : "muted"}`}>
        {newest === null
          ? "No training samples banked in the last week."
          : `Newest training sample ${ago(new Date(newest), now)}; ${(data.samples.lastHourRows ?? 0).toLocaleString()} in the last hour.`}
        {stale && " Nothing banked for over 30 minutes - the models are not learning."}
      </p>
      {health ? (
        <>
          <p className="muted small">
            Measured on {health.rows.toLocaleString()} decision moments in the newest run (base 2x rate{" "}
            {pct(health.baseWinRatePct, 1)}). Lift is a signal's top or bottom tenth's 2x rate over the base;
            1 is no signal.
          </p>
          <div className="table-wrap">
            <table className="compact">
              <thead>
                <tr>
                  <th>Strongest on its own</th>
                  <th className="r">Top tenth</th>
                  <th className="r">Bottom tenth</th>
                  <th className="r">Missing</th>
                </tr>
              </thead>
              <tbody>
                {strongest.map((f) => (
                  <tr key={f.feature}>
                    <td>{f.label}</td>
                    <td className="r num">{f.topDecileLift?.toFixed(2)}x</td>
                    <td className="r num">{f.bottomDecileLift?.toFixed(2)}x</td>
                    <td className="r num muted">{pct(f.nullRatePct, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {mostlyNull.length > 0 && (
            <p className="small muted">
              Mostly missing:{" "}
              {mostlyNull
                .slice(0, HEALTH_ROWS * 2)
                .map((f) => `${f.label} (${pct(f.nullRatePct, 0)})`)
                .join(", ")}
              {mostlyNull.length > HEALTH_ROWS * 2 ? ` and ${mostlyNull.length - HEALTH_ROWS * 2} more` : ""}.
            </p>
          )}
          {held.length > 0 && (
            <p className="small muted">
              Not used by the models yet, waiting for history:{" "}
              {held
                .map(
                  (f) =>
                    `${f.label} (on ${pct(f.recentPct, 0)} of recent moments, ${pct(f.referencePct, 0)} of the history the cutoffs come from)`,
                )
                .join(", ")}
              . A new input joins once it covers enough of that history, usually within a few days.
            </p>
          )}
        </>
      ) : (
        <p className="empty">Appears after the first training run.</p>
      )}
    </section>
  );
}

function LeaderboardPanel({
  board,
  days,
  onSetModels,
  guest = false,
  refreshing,
  now,
  detailed = false,
}: {
  board: Leaderboard;
  days: number;
  onSetModels: (models: string[] | null) => Promise<void>;
  /** No wallet: the feed picks show, greyed out, with a prompt to connect one. */
  guest?: boolean;
  /** `board` is from before the last change and its fresh copy is loading: hold further clicks. */
  refreshing: boolean;
  now: number;
  /** Every column and the scoring guides (Under the hood); otherwise the plain view with the feed picker. */
  detailed?: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const use = async (key: string, models: string[] | null) => {
    setBusy(key);
    setError(null);
    try {
      await onSetModels(models);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const t = board.targets;
  return (
    <section className="panel">
      <header className="section-head">
        <div>
          <span className="eyebrow">{detailed ? "Full leaderboard" : "Leaderboard"}</span>
          <h3>{detailed ? "Every figure, model by model" : `Who's calling it best, last ${days} days`}</h3>
          {detailed ? (
            <p className="muted small">
              Score = how far a model has proven itself toward the goal, 0 to 100. Hover a score for its
              working, or see <GuideLink id="score-guide">what the score means</GuideLink> below.
            </p>
          ) : (
            <p className="muted small">
              Ranked by <strong>vs market</strong>: how much more often a model&apos;s calls doubled than the
              average coin in the same hours, so models that started on different days compare fairly. The
              score runs from 0 to 100: 100 means a model&apos;s calls have reliably hit the goal. Profit is
              what following every call with one fixed exit plan would have returned. {RULE_NOTE}{" "}
              {guest ? (
                <>
                  Connect a wallet to pick which models&apos; alerts you get with <strong>In feed</strong>.
                </>
              ) : (
                <>
                  Tick <strong>In feed</strong> to get a model&apos;s alerts on the Live tab.
                </>
              )}
            </p>
          )}
        </div>
        {!detailed && !guest && board.followBest === false && (
          <button
            className="ghost"
            disabled={busy !== null || refreshing}
            onClick={() => void use("default", null)}
          >
            Follow the top models
          </button>
        )}
      </header>
      {error && <p className="error small">Couldn&apos;t change your feed: {error}</p>}
      {board.runners && board.runners.runners > 0 && (
        <p className="muted small">
          <strong>Caught</strong> counts the runners: of the {board.runners.runners} tokens that doubled
          cleanly in the last {days} days, the share a model called at a winning moment. All models together
          caught {board.runners.caught} ({pct(board.runners.pct)}); the other{" "}
          {board.runners.runners - board.runners.caught} slipped by every model.
        </p>
      )}
      <div className="table-wrap">
        <table className="leaderboard">
          <thead>
            <tr>
              <th className="r" title="Ranked by vs market (lift); warming-up models rank last">
                #
              </th>
              <th>Model</th>
              <th title="How far the model has proven itself toward the goal, 0-100">Score</th>
              <th className="r">{detailed ? "Live calls" : "Calls"}</th>
              <th className="r">{detailed ? "2x" : "Doubled"}</th>
              <th
                className="r"
                title="Its 2x rate over the market's 2x rate in the same hours: 2.0x means its calls doubled twice as often as a random pick then. The board ranks by this."
              >
                vs market
              </th>
              <th
                className="r"
                title="Of the tokens that doubled cleanly in the window, the share it called at a winning moment: the runners it didn't let slip"
              >
                Caught
              </th>
              <th className="r">{detailed ? "4x" : "Hit 4x"}</th>
              <th
                className="r"
                title="Share of graded live calls that reached 10x within an hour, before a 50% drop"
              >
                {detailed ? "10x" : "Hit 10x"}
              </th>
              {detailed && (
                <th className="r" title="Average doublings per call">
                  Avg doublings
                </th>
              )}
              <th className="r" title="Average simulated return per live call under the fixed exit plan">
                Avg profit
              </th>
              {detailed && (
                <>
                  <th
                    className="r"
                    title="Total simulated return over its live calls, staking the same amount on each"
                  >
                    Total profit
                  </th>
                  <th className="r">Backtest 2x / 4x / 10x</th>
                  <th
                    className="r"
                    title="Live 2x rate of its high-conviction calls alone (its top half-percent of moments)"
                  >
                    High-conv 2x
                  </th>
                  <th>Status</th>
                </>
              )}
              {!detailed && <th />}
            </tr>
          </thead>
          <tbody>
            {board.entries.map((e) => {
              const mine = board.selectedModels.includes(e.id);
              const onlyOne = mine && board.selectedModels.length === 1;
              const { live, exam } = e.composite;
              return (
                <tr key={e.id} className={mine ? "selected" : ""}>
                  <td className="r num lb-rank">{e.rank}</td>
                  <td className="model-cell">
                    <div className="row">
                      <span className="rank-inline num">#{e.rank}</span>
                      <strong>{e.name}</strong>
                      {e.isBest && (
                        <span className="chip chip-model" title={bestReturnTitle(board, now)}>
                          best 24h return
                        </span>
                      )}
                      {e.isDefault && (
                        <span
                          className="chip"
                          title="One of the top models by proven 2x rate: the default feed"
                        >
                          top
                        </span>
                      )}
                      {mine && <span className="chip">{guest ? "guest feed" : "your feed"}</span>}
                    </div>
                    {detailed ? (
                      <small className="muted">
                        {ROLE_LABEL[e.role]} · {e.description}
                      </small>
                    ) : (
                      <>
                        <small className="muted">{e.summary ?? e.description}</small>
                        {e.status !== "calling" && (
                          <small className="faint">{STATUS_TEXT[e.status].text}</small>
                        )}
                      </>
                    )}
                    {detailed && e.lane && e.lane.generation > 0 && (
                      <small className="faint lineage">
                        In this seat since {ago(e.lane.bornAt, now)}; live record counts from then
                      </small>
                    )}
                    {e.rules && <RulesInUse rules={e.rules} now={now} />}
                  </td>
                  <td data-label="Score" className="lb-score">
                    <ScoreBar
                      score={e.composite.score}
                      band={e.composite.band ?? null}
                      title={e.scoreExplained ?? scoreTitle(e.composite.liveWeight)}
                    />
                    {detailed && e.composite.basis && (
                      <small className="faint score-proof num">
                        proven 2x {e.composite.basis.proven2xPct.toFixed(0)}% · 4x{" "}
                        {e.composite.basis.proven4xPct.toFixed(0)}%
                        {e.composite.basis.provenRunDoublings != null &&
                          ` · run ${e.composite.basis.provenRunDoublings.toFixed(2)}`}
                      </small>
                    )}
                  </td>
                  <td className="r num" data-label={detailed ? "Live calls" : "Calls"}>
                    {live.calls}
                    {live.calls > live.graded && <span className="faint"> ({live.graded} graded)</span>}
                  </td>
                  <td
                    className={`r num ${rateTone(live.winRatePct, t.hitRate2xPct, live.graded)}`}
                    data-label={detailed ? "2x" : "Doubled"}
                    title={rateTitle(live.winRatePct, live.graded)}
                  >
                    {pct(live.winRatePct)}
                  </td>
                  <td
                    className={`r num ${liftTone(e.vsMarket?.lift ?? null)}`}
                    data-label="vs market"
                    title={
                      e.vsMarket?.marketRatePct != null
                        ? `The market doubled ${pct(e.vsMarket.marketRatePct, 1)} in the hours it called`
                        : undefined
                    }
                  >
                    {e.vsMarket?.lift != null ? `${e.vsMarket.lift.toFixed(1)}x` : "–"}
                  </td>
                  <td
                    className="r num"
                    data-label="Caught"
                    title={
                      e.liveCatch && e.liveCatch.runners > 0
                        ? `Called ${e.liveCatch.caught} of the ${e.liveCatch.runners} tokens that doubled since it started calling in this window`
                        : undefined
                    }
                  >
                    {pct(e.liveCatch?.pct ?? null)}
                  </td>
                  <td
                    className={`r num ${rateTone(live.goalRatePct, t.hitRate4xPct, live.graded)}`}
                    data-label={detailed ? "4x" : "Hit 4x"}
                    title={rateTitle(live.goalRatePct, live.graded)}
                  >
                    {pct(live.goalRatePct)}
                  </td>
                  <td className="r num" data-label={detailed ? "10x" : "Hit 10x"}>
                    {pct(live.tenXRatePct, live.tenXRatePct != null && live.tenXRatePct < 10 ? 1 : 0)}
                  </td>
                  {detailed && (
                    <td className="r num" data-label="Avg doublings">
                      {doublings(live.avgReturnDoublings)}
                    </td>
                  )}
                  <td className={`r num ${profitTone(live.avgSimReturnPct)}`} data-label="Avg profit">
                    {signedPct(live.avgSimReturnPct)}
                  </td>
                  {detailed && (
                    <>
                      <td
                        className={`r num ${profitTone(live.totalSimReturnPct)}`}
                        data-label="Total profit"
                        title={
                          live.simCalls
                            ? `${live.simCalls} graded call${live.simCalls === 1 ? "" : "s"} with a simulated result`
                            : undefined
                        }
                      >
                        {stakes(live.totalSimReturnPct)}
                      </td>
                      <td className="r num muted" data-label="Backtest">
                        {exam.graded > 0
                          ? `${pct(exam.winRatePct)} / ${pct(exam.goalRatePct)}${
                              exam.tenXRatePct != null ? ` / ${pct(exam.tenXRatePct, 1)}` : ""
                            }`
                          : "–"}
                        {exam.graded > 0 && <span className="faint"> · {exam.graded}</span>}
                      </td>
                      <td
                        className={`r num ${e.highConviction ? rateTone(e.highConviction.winRatePct, t.hitRate2xPct, e.highConviction.graded) : "muted"}`}
                        data-label="High-conv 2x"
                      >
                        {e.highConviction ? pct(e.highConviction.winRatePct) : "–"}
                        {e.highConviction && <span className="faint"> · {e.highConviction.graded}</span>}
                      </td>
                      <td className="lb-status">
                        <span className={`badge ${STATUS_TEXT[e.status].tone}`}>
                          {STATUS_TEXT[e.status].text}
                        </span>
                        {e.composite.warmingUp && e.status === "calling" && (
                          <span
                            className="badge neutral"
                            title={`Fewer than ${board.scoring.minLiveCallsToRank ?? 50} graded live calls: ranked behind seasoned models until then`}
                          >
                            warming up
                          </span>
                        )}
                      </td>
                    </>
                  )}
                  {!detailed && (
                    <td className="r lb-feed">
                      <label
                        className={`in-feed${guest ? " locked" : ""}`}
                        title={
                          guest
                            ? "Connect a wallet to pick models"
                            : onlyOne
                              ? "Your feed needs at least one model"
                              : "Show this model's calls in your feed"
                        }
                      >
                        <input
                          type="checkbox"
                          checked={mine}
                          disabled={guest || busy !== null || refreshing || onlyOne}
                          onChange={() => void use(e.id, toggledModels(board, e.id))}
                        />
                        In feed
                      </label>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {detailed && (
        <>
          <p className="faint small">
            Avg doublings is the average return per call: a 2x counts 1, a 4x counts 2, a miss or a stop-out
            0. It is shown for context and not scored. Avg and total profit follow every live call with one
            fixed exit plan, so a feed whose losers lose a lot shows it even when its hit rate looks fine; see{" "}
            <GuideLink id="profit-guide">what profit means</GuideLink>. Backtest figures are the latest
            training run's walk-forward exam, with the number of calls it made. {RULE_NOTE} Rates on fewer
            than {MIN_GRADED_FOR_RATE} graded calls are muted as early; hover one for its 90% range.
          </p>
          <ScoreGuide board={board} />
          <ProfitGuide board={board} />
        </>
      )}
    </section>
  );
}

/**
 * A link to one of the guides further down the panel. A plain `href="#score-guide"` would change
 * the hash, and the hash picks the tab (routes.ts), so the click used to throw the reader back
 * to the Live tab; this opens the guide and scrolls to it instead.
 */
function GuideLink({ id, children }: { id: string; children: ReactNode }) {
  return (
    <a
      href={`#${id}`}
      onClick={(e) => {
        e.preventDefault();
        const el = document.getElementById(id);
        if (!el) return;
        if (el instanceof HTMLDetailsElement) el.open = true;
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }}
    >
      {children}
    </a>
  );
}

function scoreTitle(liveWeight: number): string {
  return `${Math.round(liveWeight * 100)}% from live calls, ${Math.round((1 - liveWeight) * 100)}% from the backtest`;
}

/**
 * What the score means, in words a trader can act on: the bands, the two parts, the small-sample
 * rule, and the board's top scorer worked through as an example.
 */
function ScoreGuide({ board }: { board: Leaderboard }) {
  const sc = board.scoring;
  const t = board.targets;
  const w = sc.weights;
  const runTarget = sc.runTargetDoublings ?? 2;
  const example = board.entries.find((e) => e.composite.basis && e.composite.score !== null);
  const b = example?.composite.basis;
  const bands = sc.bands ?? [];
  return (
    <details className="score-guide" id="score-guide">
      <summary>What the score means</summary>
      <div className="score-guide-body">
        <p className="muted small">
          A model's score is how far it has <strong>proven</strong> itself toward the goal: 2x on{" "}
          {t.hitRate2xPct}% of its calls and 4x on {t.hitRate4xPct}%, catching the big runs these tokens make,
          and calling {board.scoring.catchTargetPct ?? 75}% of the runners rather than letting them slip by.
          100 means its record meets every target. 0 means it has proven nothing yet.
        </p>
        {bands.length > 0 && (
          <ul className="score-bands">
            {bands.map((band, i) => (
              <li key={band.id}>
                <span className={`badge ${BAND_TONE[band.id]}`}>{band.label}</span>
                <span className="num muted small">
                  {band.min}
                  {i === 0 ? "–100" : `–${(bands[i - 1]?.min ?? 100) - 1}`}
                </span>
                <span className="small">{band.meaning}</span>
              </li>
            ))}
          </ul>
        )}
        <ol className="steps small">
          <li>
            <strong>{Math.round(w.winRate * 100)} points for hitting 2x.</strong> The model's proven 2x rate
            as a share of the {t.hitRate2xPct}% target: proving {Math.round(t.hitRate2xPct / 2)}% earns half
            the points, proving {t.hitRate2xPct}% or more earns them all.
          </li>
          <li>
            <strong>{Math.round(w.goalRate * 100)} points for hitting 4x.</strong> The same, against the{" "}
            {t.hitRate4xPct}% target.
          </li>
          {w.tenXRate != null && (
            <li>
              <strong>{Math.round(w.tenXRate * 100)} points for hitting 10x.</strong> The share of calls that
              reached 10x within an hour of the alert (before a 50% drop), against a {sc.tenXTargetPct ?? 25}%
              target.
            </li>
          )}
          {w.runSize != null && (
            <li>
              <strong>{Math.round(w.runSize * 100)} points for run size.</strong> How far its calls went over
              the 24 hours after the call, counted in doublings (a 4x is 2, a 32x is 5, capped at 100x),
              averaged over every call against a target of {runTarget} (a {2 ** runTarget}x average). A call
              scores 0 if it fell 50% before running or never doubled. A 2x that stops there and one that runs
              to 50x earn the same points above; this is what tells them apart.
            </li>
          )}
          {w.catchRate != null && (
            <li>
              <strong>{Math.round(w.catchRate * 100)} points for catching runners.</strong> Of the tokens that
              doubled in its backtest, the share it called at a winning moment, against a{" "}
              {sc.catchTargetPct ?? 75}% target. The hit rates alone reward a model for calling only its
              surest few; this part counts the runners it let slip by. Only the backtest knows every runner a
              model could have called, so a model without one is scored on the other parts, scaled to 100.
            </li>
          )}
          <li>
            <strong>Proven, not raw.</strong> Before a rate or the run size is worked out,{" "}
            {sc.priorCalls ?? 10} extra calls are counted as misses. Three wins from three calls proves{" "}
            {pct((3 / (3 + (sc.priorCalls ?? 10))) * 100)}, not 100%; 150 wins from 200 calls proves{" "}
            {pct((150 / (200 + (sc.priorCalls ?? 10))) * 100)}. A short hot streak can't outscore a long good
            record.
          </li>
          <li>
            <strong>Live calls first.</strong> A new model is scored on its backtest, which counts for at most{" "}
            {sc.livePivotCalls} calls' worth. Its live calls add to that one by one, so by {sc.livePivotCalls}{" "}
            graded live calls the two weigh the same, and from there the live record takes over. Models with
            fewer than {sc.minLiveCallsToRank ?? 50} graded live calls are "warming up": their score shows,
            but they rank below every seasoned model.
          </li>
          <li>
            <strong>Beating a target earns nothing extra.</strong> Two models that both meet the goal tie at
            100; the one with more graded live calls ranks first.
          </li>
        </ol>
        {example && b && example.composite.score !== null && (
          <p className="muted small score-example">
            <strong>Worked example, {example.name}:</strong> {b.liveCalls} graded live call
            {b.liveCalls === 1 ? "" : "s"}
            {b.backtestCalls > 0 ? ` plus a backtest counting as ${b.backtestCalls}` : ""} prove a 2x rate of{" "}
            <span className="num">{b.proven2xPct.toFixed(0)}%</span> ({Math.round(w.winRate * 100)} ×{" "}
            {b.proven2xPct.toFixed(0)}/{t.hitRate2xPct} = <span className="num">{b.points2x.toFixed(0)}</span>{" "}
            points) and a 4x rate of <span className="num">{b.proven4xPct.toFixed(0)}%</span> (
            {Math.round(w.goalRate * 100)} × {b.proven4xPct.toFixed(0)}/{t.hitRate4xPct} ={" "}
            <span className="num">{b.points4x.toFixed(0)}</span> points)
            {b.points10x != null && b.proven10xPct != null && w.tenXRate != null && (
              <>
                , a 10x rate of <span className="num">{b.proven10xPct.toFixed(0)}%</span> (
                {Math.round(w.tenXRate * 100)} × {b.proven10xPct.toFixed(0)}/{sc.tenXTargetPct ?? 25} ={" "}
                <span className="num">{b.points10x.toFixed(0)}</span> points)
              </>
            )}
            {b.pointsRun != null && b.provenRunDoublings != null && w.runSize != null && (
              <>
                {" "}
                and a run size of <span className="num">{b.provenRunDoublings.toFixed(2)}</span> doublings a
                call ({Math.round(w.runSize * 100)} × {b.provenRunDoublings.toFixed(2)}/{runTarget} ={" "}
                <span className="num">{b.pointsRun.toFixed(0)}</span> points)
              </>
            )}
            {b.pointsCatch != null && b.provenCatchPct != null && w.catchRate != null && (
              <>
                {" "}
                and a catch rate of <span className="num">{b.provenCatchPct.toFixed(0)}%</span> (
                {Math.round(w.catchRate * 100)} × {b.provenCatchPct.toFixed(0)}/{sc.catchTargetPct ?? 75} ={" "}
                <span className="num">{b.pointsCatch.toFixed(0)}</span> points)
              </>
            )}
            , for a score of <span className="num">{example.composite.score.toFixed(0)}</span>
            {example.composite.band ? `: ${example.composite.band.label.toLowerCase()}` : ""}.
          </p>
        )}
      </div>
    </details>
  );
}

/**
 * What the simulated profit columns mean: the exit plan, how one call is worked out, and the
 * board's best total worked through as an example.
 */
function ProfitGuide({ board }: { board: Leaderboard }) {
  const example = [...board.entries]
    .filter((e) => (e.composite.live.simCalls ?? 0) > 0 && e.composite.live.totalSimReturnPct != null)
    .sort((a, b) => (b.composite.live.totalSimReturnPct ?? 0) - (a.composite.live.totalSimReturnPct ?? 0))[0];
  const live = example?.composite.live;
  return (
    <details className="score-guide" id="profit-guide">
      <summary>What the profit columns mean</summary>
      <div className="score-guide-body">
        <p className="muted small">
          A hit rate counts each call as a win or a loss, so it can't tell a feed whose misses drift 10% lower
          from one whose misses fall 50%. The profit columns put a return on every graded call by following it
          with one fixed plan, the same for every model:
        </p>
        <p className="small">
          <strong>
            {board.exitPlan ??
              "Buy at the alert price, sell half at 2x, let the rest ride with a trailing exit 35% off its high, out at 3 hours, stop out at -50% before the first sale, and close a call that never sold at 30 minutes."}
          </strong>
        </p>
        <ol className="steps small">
          <li>
            <strong>The entry is the one the hit rates use:</strong> the price the token was at when it was
            detected and alerted.
          </li>
          <li>
            <strong>Some worked calls.</strong> One that runs to 4x returns +200% (half sold at 2x, half at
            4x). One that doubles and then falls to the stop returns +25%. One that drops to the stop first
            returns -50%. One that ends its 30 minutes 20% up without reaching 2x returns +20%.
          </li>
          <li>
            <strong>Avg profit</strong> is the average return per graded live call.{" "}
            <strong>Total profit</strong> adds them up in stakes: staking the same amount on every call, +3.0
            stakes means the model's calls made three times that amount over the window, after the losers.
          </li>
          <li>
            <strong>It is a simulation, not a promise.</strong> Prices are checked about once a minute. The
            sale at 2x and the -50% stop are assumed to fill at the level itself; in a fast dump a real stop
            can fill lower. The trailing exit books the price actually seen under its level, since a trail
            fires on a sharp drop by construction. Calls whose last price is unknown are left out rather than
            guessed.
          </li>
        </ol>
        {example && live && (
          <p className="muted small score-example">
            <strong>Example, {example.name}:</strong> {live.simCalls} graded live call
            {live.simCalls === 1 ? "" : "s"} averaged{" "}
            <span className="num">{signedPct(live.avgSimReturnPct, 1)}</span> each, a total of{" "}
            <span className="num">{stakes(live.totalSimReturnPct)}</span> over the last {board.window.days}{" "}
            days.
          </p>
        )}
      </div>
    </details>
  );
}

function HowItWorks({ board }: { board: Leaderboard }) {
  const learners = board.entries.filter((e) => e.role === "learner").map((e) => e.name);
  const w = board.scoring.weights;
  return (
    <section className="panel">
      <span className="eyebrow">How it works</span>
      <h3>From graded history to a call</h3>
      <ol className="steps">
        <li>
          <strong>Train.</strong> Every few hours each model refits on the last weeks of graded decision
          moments: what a token looked like, and whether it then hit 2x on the alert price within 15 minutes.
          The models differ on purpose: {learners.join(", ")} see the market through different families,
          memories and signals.
        </li>
        <li>
          <strong>Exam.</strong> Before it ships, each model sits a walk-forward exam: trained on the past,
          graded on later weeks it never saw, the way it would have traded them.
        </li>
        <li>
          <strong>Cutoff.</strong> Each model only calls its most confident slice: the loosest one whose exam
          calls reached {board.targets.hitRate2xPct}% 2x and {board.targets.hitRate4xPct}% 4x, or its best
          slice when none did. A model with no slice to judge stays silent until the next run.
        </li>
        <li>
          <strong>Battle.</strong> Every model calls on its own feed, graded the same way. The leaderboard
          score is how far each has proven itself toward the goal, 0-100: {Math.round(w.winRate * 100)} points
          for its 2x rate against the {board.targets.hitRate2xPct}% target, {Math.round(w.goalRate * 100)} for
          its 4x rate against {board.targets.hitRate4xPct}%
          {w.tenXRate != null
            ? `, ${Math.round(w.tenXRate * 100)} for how often its calls hit 10x within an hour`
            : ""}
          {w.runSize != null
            ? `, and ${Math.round(w.runSize * 100)} for run size, how far its calls run over the day after`
            : ""}
          , with a few phantom misses added so a short streak proves little. It starts from the backtest and
          shifts to live calls as they're graded (half and half at {board.scoring.livePivotCalls}).
        </li>
        <li>
          <strong>Evolve.</strong> Every run also breeds {board.evolution.challengersPerRun} challenger
          {board.evolution.challengersPerRun === 1 ? "" : "s"}: copies of the top half's recipes with one or
          two settings changed (memory, depth, learning rate, which signals it reads), sometimes crossed with
          another leader. They sit the same exam. When the best one beats the weakest model's exam by{" "}
          {board.evolution.margin} points (by a wider bar the more challengers there are)
          {board.evolution.probationHours
            ? `, it waits ${board.evolution.probationHours} hours and must beat that model again on the calls that came in since. Then it takes`
            : ", it takes"}{" "}
          that seat under a new name and starts a fresh live record. A model holds its seat at least{" "}
          {board.evolution.minAgeHours} hours first.
        </li>
        <li>
          <strong>Consensus.</strong> A second-order model trained on the others' out-of-sample calls: it
          learns which models to trust and when they agree, and gets its own exam on later weeks than it
          trained on.
        </li>
        <li>
          <strong>The default.</strong>{" "}
          {board.defaultRule ? (
            <>
              The default feed is the {board.defaultRule.count} models with the best 2x rate at the low end of
              its {board.defaultRule.rankConfidencePct ?? 95}% range (so a short record counts for less),
              among those with at least {board.defaultRule.rankMinGraded ?? board.defaultRule.minGraded}{" "}
              graded calls over the last {board.defaultRule.rankWindowHours ?? board.defaultRule.windowHours}
              h, picked every {Math.round(board.defaultRule.refreshMinutes / 60)} hours (00, 06, 12 and 18
              UTC) and held until the next pick. Everyone who follows the default sees their calls combined.
              Until enough models qualify, it is the best performer on this board alone.
            </>
          ) : (
            <>
              After each run the best performer on this board (with at least{" "}
              {board.champion?.minLiveGraded ?? 10} graded live calls) becomes the default feed, and everyone
              who follows the best switches to it. Until a model qualifies, the default is the Consensus when
              it can call, else Rules.
            </>
          )}
        </li>
      </ol>
    </section>
  );
}

function EvolutionPanel({ board, now }: { board: Leaderboard; now: number }) {
  const ev = board.evolution;
  const takeovers = ev.history.filter((h) => h.generation > 0);
  const best = takeovers.reduce<EvolutionEvent | null>(
    (b, h) => (h.examScore !== null && (b === null || h.examScore > (b.examScore ?? -1)) ? h : b),
    null,
  );
  return (
    <section className="panel">
      <header className="section-head">
        <div>
          <span className="eyebrow">Evolution</span>
          <h3>How the field is changing</h3>
          <p className="muted small">
            {ev.challengersPerRun === 0
              ? "Evolution is paused: the field trains as it is."
              : `Every ${ev.runEveryHours}h, ${ev.challengersPerRun} bred challenger${
                  ev.challengersPerRun === 1 ? "" : "s"
                } sit the exam. At most one takes a seat per run.`}
          </p>
          {ev.probation && (
            <p className="muted small">
              On probation: <strong>{ev.probation.name}</strong> beat {ev.probation.seatName} on the exam{" "}
              {ago(ev.probation.startedAt, now)} and takes its seat only if it beats it again on the calls
              since.
            </p>
          )}
        </div>
        {best && (
          <div className="evo-best">
            <span className="faint small">Best bred exam</span>
            <strong className="num">{best.examScore!.toFixed(0)}</strong>
            <small className="muted">{best.name}</small>
          </div>
        )}
      </header>
      {takeovers.length === 0 ? (
        <p className="muted small">
          No takeovers yet. The founding models hold their seats for at least {ev.minAgeHours} hours, then the
          weakest can be replaced by a challenger that beats its exam by {ev.margin} points.
        </p>
      ) : (
        <ol className="evo-list">
          {takeovers.map((h) => (
            <li key={`${h.slot}:${h.generation}`} className={h.retiredAt ? "retired" : ""}>
              <div className="row">
                <strong>{h.name}</strong>
                <span className={`chip ${h.retiredAt ? "" : "chip-model"}`}>
                  {h.retiredAt ? `replaced ${ago(h.retiredAt, now)}` : "holding a seat"}
                </span>
                <span className="faint small">seated {ago(h.bornAt, now)}</span>
                {h.examScore !== null && (
                  <span className="faint small num">exam {h.examScore.toFixed(0)}</span>
                )}
              </div>
              <small className="muted">{h.description}</small>
              {h.retiredReason && <small className="faint">{h.retiredReason}</small>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

const TREND_TEXT: Record<LearningTrend["verdict"], string> = {
  improving: "▲ Improving",
  flat: "→ Holding steady",
  worsening: "▼ Slipping",
  "too-early": "Too early to say",
};

const TREND_STATE: Record<LearningTrend["verdict"], string> = {
  improving: "met",
  flat: "early",
  worsening: "below",
  "too-early": "early",
};

function shortDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Fewest graded calls a model needs on a day before the learning chart plots that day. */
const MIN_CALLS_PER_POINT = 5;

/** What the learning panel can chart, each for the model and the market alike. */
const LEARNING_METRICS = {
  "2x": {
    tab: "2x",
    fig: "2x rate",
    series: "2x rate",
    hit: "doubled",
    of: (r: LearningRates) => r.rate2xPct,
    note: "A 2x is a double within 15 minutes, before the 50% stop.",
  },
  "4x": {
    tab: "4x",
    fig: "4x rate",
    series: "4x rate",
    hit: "reached 4x",
    of: (r: LearningRates) => r.rate4xPct,
    note: "A 4x is reached within 30 minutes, before the 50% stop.",
  },
  "10x": {
    tab: "10x",
    fig: "10x rate",
    series: "10x rate",
    hit: "reached 10x",
    of: (r: LearningRates) => r.rate10xPct ?? null,
    note: "A 10x is reached within an hour, before the 50% stop; calls still inside their hour wait.",
  },
  ret: {
    tab: "Avg return",
    fig: "Avg return",
    series: "avg return",
    hit: "",
    of: (r: LearningRates) => r.avgReturnPct ?? null,
    note: "Average return per call, following every call with one fixed exit plan; the market line is a random pick under the same plan.",
  },
} as const;
type LearningMetric = keyof typeof LEARNING_METRICS;
const LEARNING_METRIC_KEYS = Object.keys(LEARNING_METRICS) as LearningMetric[];

const sumOf = (rows: LearningRates[], f: (r: LearningRates) => number | undefined) =>
  rows.reduce((n, r) => n + (f(r) ?? 0), 0);

/** Days' rates pooled into one figure per measure: wins over graded calls, not a mean of daily rates. */
function pooledRates(rows: LearningRates[]): Record<LearningMetric, number | null> {
  const share = (won: number, of: number) => (of > 0 ? (won / of) * 100 : null);
  const g = sumOf(rows, (r) => r.graded);
  return {
    "2x": share(
      sumOf(rows, (r) => r.won2x),
      g,
    ),
    "4x": share(
      sumOf(rows, (r) => r.won4x),
      g,
    ),
    "10x": share(
      sumOf(rows, (r) => r.won10x),
      sumOf(rows, (r) => r.tenXGraded),
    ),
    ret:
      sumOf(rows, (r) => r.simCalls) > 0
        ? sumOf(rows, (r) => r.sumSimReturnPct) / sumOf(rows, (r) => r.simCalls)
        : null,
  };
}

/** Most models the week panel draws at once: one per categorical color slot. */
const WEEK_MAX_MODELS = 5;
const WEEK_DAYS = 7;

/** The UTC day keys of the `n` days ending at `last` (YYYY-MM-DD), oldest first. */
function dayKeys(last: string, n: number): string[] {
  const end = Date.parse(`${last}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) =>
    new Date(end - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10),
  );
}

/**
 * Is it getting better? The last seven days side by side: the market and every model pooled always
 * drawn, plus up to five models the reader picks, on one chart and one share image. Hit rates alone
 * move with the market - on a day the whole market doubles twice as often every model looks twice
 * as good - so each line is read against the market's line for the same day.
 */
function WeekPanel({ learning, board, now }: { learning: LearningCurve; board: Leaderboard; now: number }) {
  const series = new Map((learning.models ?? []).map((m) => [m.model, m]));
  const seats = board.entries.map((e) => ({ id: e.id, name: e.name }));
  const today = new Date(now).toISOString().slice(0, 10);
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const [withToday, setWithToday] = useState(false);
  const [metric, setMetric] = useState<LearningMetric>("2x");
  const [sharing, setSharing] = useState(false);
  const keys = dayKeys(withToday ? today : yesterday, WEEK_DAYS);
  const inWeek = new Set(keys);
  const callsInWeek = (id: string) =>
    (series.get(id)?.days ?? []).reduce((n, d) => n + (inWeek.has(d.day) ? d.rates.graded : 0), 0);
  // Until the reader picks, the board's top three that called this week.
  const [chosen, setChosen] = useState<string[] | null>(null);
  const picked = (chosen ?? seats.filter((s) => callsInWeek(s.id) > 0).map((s) => s.id))
    .filter((id) => seats.some((s) => s.id === id))
    .slice(0, chosen ? WEEK_MAX_MODELS : 3);
  const toggle = (id: string) =>
    setChosen(
      picked.includes(id)
        ? picked.filter((x) => x !== id)
        : picked.length < WEEK_MAX_MODELS
          ? [...picked, id]
          : picked,
    );

  const m = LEARNING_METRICS[metric];
  const byDay = new Map(learning.days.map((d) => [d.day, d]));
  const labels = keys.map((k) => (k === today ? "Today" : shortDay(k)));
  const pricingChange = pricingChangePoint(dayStarts(keys), DAY_MS);
  const nameOf = (id: string) => seats.find((s) => s.id === id)?.name ?? series.get(id)?.name ?? id;
  const modelRows = picked.map((id, i) => {
    const own = new Map((series.get(id)?.days ?? []).map((d) => [d.day, d.rates]));
    const rows = keys.map((k) => own.get(k)).filter((r): r is LearningRates => !!r);
    return {
      key: id,
      label: nameOf(id),
      tone: `s${i + 1}`,
      // A day needs a few graded calls, as on the single-model chart; fewer leave a gap.
      values: keys.map((k) => {
        const r = own.get(k);
        return r && r.graded >= MIN_CALLS_PER_POINT ? m.of(r) : null;
      }),
      week: pooledRates(rows),
      graded: sumOf(rows, (r) => r.graded),
    };
  });
  const marketRows = keys.map((k) => byDay.get(k)?.market).filter((r): r is LearningRates => !!r);
  const feedRows = keys.map((k) => byDay.get(k)?.feed).filter((r): r is LearningRates => !!r);
  const market = {
    key: "market",
    label: "Market",
    tone: "ref",
    values: keys.map((k) => {
      const r = byDay.get(k)?.market;
      return r && r.graded > 0 ? m.of(r) : null;
    }),
    week: pooledRates(marketRows),
    graded: sumOf(marketRows, (r) => r.graded),
  };
  const all = {
    key: "all",
    label: "All models",
    tone: "all",
    values: keys.map((k) => {
      const r = byDay.get(k)?.feed;
      return r && r.graded >= MIN_CALLS_PER_POINT ? m.of(r) : null;
    }),
    week: pooledRates(feedRows),
    graded: sumOf(feedRows, (r) => r.graded),
  };
  const lines = [...modelRows, all, market];
  const anyData = lines.some((l) => l.values.some((v) => v !== null));
  const fmt = (v: number | null) => (metric === "ret" ? signedPct(v, 1) : pct(v, 1));
  const vsMarket = (v: number | null) => {
    const base = market.week[metric];
    if (v === null || base === null) return "–";
    if (metric === "ret") return signedPct(v - base, 1);
    return base > 0 ? `${(v / base).toFixed(1)}x` : "–";
  };

  const card = (): WeekCardData => ({
    metric,
    labels,
    lines: lines.map((l) => ({ label: l.label, tone: l.tone, values: l.values, week: l.week[metric] })),
    graded: all.graded,
    pricingChange,
  });

  return (
    <section className="panel learning-panel">
      <header className="section-head">
        <div>
          <span className="eyebrow">
            <ChartIcon size={13} /> Learning, last {WEEK_DAYS} days
          </span>
          <h3>Is it getting better?</h3>
          <p className="muted small">
            Up to {WEEK_MAX_MODELS} models day by day, next to the market (a random pick from the moments the
            models choose from) and every model&apos;s calls pooled, each token counted once however many
            models called it. A model that is learning pulls further above the dashed market line over the
            days. If every line rises together, that&apos;s the market, not the models.
          </p>
        </div>
        <div className="learning-tools">
          <button
            type="button"
            className="ghost share-btn"
            disabled={!anyData}
            onClick={() => setSharing(true)}
          >
            <ShareIcon size={14} /> Share
          </button>
        </div>
      </header>

      {seats.length > 0 ? (
        <div className="model-pick" role="group" aria-label={`Models, up to ${WEEK_MAX_MODELS}`}>
          {seats.map((s) => {
            const at = picked.indexOf(s.id);
            const on = at >= 0;
            const full = !on && picked.length >= WEEK_MAX_MODELS;
            const has = callsInWeek(s.id) > 0;
            return (
              <button
                key={s.id}
                type="button"
                aria-pressed={on}
                className={`${on ? "on" : ""}${has ? "" : " quiet"}`}
                disabled={full}
                onClick={() => toggle(s.id)}
                title={
                  full
                    ? `Up to ${WEEK_MAX_MODELS} models; drop one to add another`
                    : has
                      ? undefined
                      : `No graded calls in these ${WEEK_DAYS} days`
                }
              >
                {on && <i className={`swatch s${at + 1}`} />}
                {s.name}
              </button>
            );
          })}
        </div>
      ) : (
        <p className="empty">No models on the board yet.</p>
      )}

      <div className="row learning-controls">
        <div className="segmented small" role="group" aria-label="Measure">
          {LEARNING_METRIC_KEYS.map((k) => (
            <button
              key={k}
              className={k === metric ? "on" : ""}
              aria-pressed={k === metric}
              onClick={() => setMetric(k)}
            >
              {LEARNING_METRICS[k].tab}
            </button>
          ))}
        </div>
        <div className="segmented small" role="group" aria-label="Last day">
          <button
            className={withToday ? "" : "on"}
            aria-pressed={!withToday}
            onClick={() => setWithToday(false)}
          >
            Ending yesterday
          </button>
          <button
            className={withToday ? "on" : ""}
            aria-pressed={withToday}
            onClick={() => setWithToday(true)}
          >
            Ending today
          </button>
        </div>
        <span className="muted small">
          {picked.length} of {WEEK_MAX_MODELS} picked
        </span>
      </div>

      {anyData ? (
        <MultiLines
          labels={labels}
          series={lines}
          signed={metric === "ret"}
          pricingChange={pricingChange}
          subs={keys.map((k) => {
            const d = byDay.get(k);
            return d
              ? `${d.feed.graded} graded calls across all models; ${d.market.graded.toLocaleString()} moments`
              : "No data";
          })}
        />
      ) : (
        <p className="empty">No graded calls in these {WEEK_DAYS} days yet.</p>
      )}

      <div className="table-wrap">
        <table className="week-table">
          <thead>
            <tr>
              <th>{WEEK_DAYS}-day total</th>
              <th className="r">{m.fig}</th>
              <th className="r">Vs market</th>
              <th className="r">Graded</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.key}>
                <td>
                  <i className={`swatch ${l.tone}`} />
                  {l.label}
                </td>
                <td className={`r num${metric === "ret" ? ` ${profitTone(l.week[metric])}` : ""}`}>
                  {fmt(l.week[metric])}
                </td>
                <td className="r num">{l.key === "market" ? "–" : vsMarket(l.week[metric])}</td>
                <td className="r num">{l.graded.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="faint small">
        {m.note} A model&apos;s day shows once it has {MIN_CALLS_PER_POINT} graded calls; fewer leave a gap.
        The table pools each line&apos;s calls over the {WEEK_DAYS} days. For the market, &quot;graded&quot;
        counts decision moments. {RULE_NOTE}
      </p>

      {sharing && (
        <ShareImageDialog
          title={`Last ${WEEK_DAYS} days, ${m.tab}`}
          fileName="trenchscanner-last-7-days-vs-market"
          caption="TrenchScanner models vs the market, last 7 days"
          link="trenchscanner.app"
          render={() => renderWeekCard(card())}
          onClose={() => setSharing(false)}
        />
      )}
    </section>
  );
}

function TrainingPanel({
  runs,
  board,
  targets,
  now,
}: {
  runs: ModelRun[];
  board: Leaderboard;
  targets: Leaderboard["targets"];
  now: number;
}) {
  // The newest run per model, in leaderboard order.
  const latestByModel = new Map<string, ModelRun>();
  for (const run of runs) {
    if (run.contestant && !latestByModel.has(run.contestant)) latestByModel.set(run.contestant, run);
  }
  const options = board.entries.filter((e) => latestByModel.has(e.id));
  const [chosen, setChosen] = useState<string | null>(null);
  const shownId = chosen && latestByModel.has(chosen) ? chosen : (options[0]?.id ?? null);
  const run = shownId ? latestByModel.get(shownId)! : (runs[0] ?? null);
  const examRates = run ? runExamRates(run) : null;

  return (
    <section className="panel">
      <header className="section-head">
        <div>
          <span className="eyebrow">Training</span>
          <h3>Latest exam, model by model</h3>
          {run && (
            <p className="muted small">
              {ago(run.createdAt, now)} on {run.trainingRows.toLocaleString()} graded moments.
              {run.verdict && ` ${run.verdict.reason}`}
            </p>
          )}
        </div>
        {options.length > 1 && (
          <select
            className="run-picker"
            value={shownId ?? ""}
            onChange={(e) => setChosen(e.target.value)}
            aria-label="Model"
          >
            {options.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        )}
      </header>

      {!run ? (
        <p className="empty">
          No training run yet. The models train once enough graded decision moments exist.
        </p>
      ) : (
        <>
          <h4>Hit rate vs how picky the cutoff is</h4>
          <p className="muted small">
            Calling only the top slice by confidence trades volume for hit rate. This is the out-of-sample
            record of each slice
            {examRates?.calls
              ? examRates.heldOut
                ? `; graded at cutoffs set on other parts of the exam, the model made ${examRates.calls} exam calls at ${pct(
                    examRates.winRatePct,
                  )} / ${pct(examRates.goalRatePct)}`
                : `; this run stored no held-out exam, so its cutoff's figure is ${IN_SAMPLE_LABEL}: ${examRates.calls} calls at ${pct(
                    examRates.winRatePct,
                  )} / ${pct(examRates.goalRatePct)}, picked on those same calls, so it reads high`
              : ""}
            . Slices on fewer than {MIN_GRADED_FOR_RATE} calls are faded as early; hover a slice for its 90%
            range.
          </p>
          {run.precisionCurve.length > 0 ? (
            <TargetBars
              aLabel="Doubled (2x)"
              bLabel="Reached 4x"
              aTarget={targets.hitRate2xPct}
              bTarget={targets.hitRate4xPct}
              data={run.precisionCurve.map((p, i) => ({
                // Slices too thin to hold one call are skipped from the front, so align from the end.
                label: `Top ${CURVE_SLICES[CURVE_SLICES.length - run.precisionCurve.length + i] ?? "?"}%`,
                shortLabel: `${CURVE_SLICES[CURVE_SLICES.length - run.precisionCurve.length + i] ?? "?"}%`,
                a: p.winRatePct,
                b: p.goalRatePct,
                sub: `${p.alerts} calls${isEarly(p.alerts) ? " · early" : ""}`,
                shortSub: `${p.alerts}`,
                thin: isEarly(p.alerts),
                note: `2x ${intervalText(wilsonOfRate(p.winRatePct, p.alerts))}`,
              }))}
            />
          ) : (
            <p className="empty">Not enough out-of-sample calls to draw yet.</p>
          )}

          {run.folds.length > 0 && (
            <details className="folds">
              <summary>Walk-forward exam, fold by fold</summary>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Test window</th>
                      <th className="r">Rows</th>
                      <th className="r">Base 2x</th>
                      <th className="r">Calls</th>
                      <th className="r">2x</th>
                      <th className="r">4x</th>
                    </tr>
                  </thead>
                  <tbody>
                    {run.folds.map((f) => {
                      const side = run.contestant === "rules" ? f.heuristic : f.model;
                      return (
                        <tr key={f.testFrom}>
                          <td className="muted">
                            {new Date(f.testFrom).toLocaleDateString()} –{" "}
                            {new Date(f.testTo).toLocaleDateString()}
                          </td>
                          <td className="r num">{f.testRows}</td>
                          <td className="r num">{pct(f.baseWinRatePct, 1)}</td>
                          <td className="r num">{side.emitted}</td>
                          <td className="r num">{pct(side.precisionPct)}</td>
                          <td className="r num">{pct(side.goalPrecisionPct)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </details>
          )}

          <details className="folds">
            <summary>Training history</summary>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Trained</th>
                    <th>Model</th>
                    <th className="r">Rows</th>
                    <th>Status</th>
                    <th className="r">Cutoff 2x</th>
                    <th className="r">Cutoff 4x</th>
                    <th className="r">Exam calls</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id}>
                      <td className="muted">{ago(r.createdAt, now)}</td>
                      <td>
                        {r.contestantName ??
                          (r.learner === "gbdt" ? "GBDT (pre-contest)" : "Logistic (pre-contest)")}
                      </td>
                      <td className="r num">{r.trainingRows.toLocaleString()}</td>
                      <td>
                        <span className={`chip ${r.status === "active" ? "chip-model" : ""}`}>
                          {r.status}
                        </span>
                      </td>
                      <td className="r num">{pct(runExamRates(r).winRatePct)}</td>
                      <td className="r num">{pct(runExamRates(r).goalRatePct)}</td>
                      <td className="r num">
                        {runExamRates(r).calls ?? "–"}
                        {runExamRates(r).calls != null && !runExamRates(r).heldOut && (
                          <span className="faint" title={IN_SAMPLE_LABEL}>
                            {" "}
                            in-sample
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}

const OUTCOME_TEXT: Record<ModelInsights["recentAiReviews"][number]["outcome"], string> = {
  pending: "◷ in its window",
  won: "✓ 2x",
  won4x: "✓✓ 4x",
  won10x: "✓✓✓ 10x",
  missed: "✕ missed",
  // A loss with its own mark, as on the feed's cards (outcome.ts).
  stopped: "⊘ stopped out",
  unknown: "–",
};

/** The AI reviewer, kept small and collapsed: it reviews the default feed's calls and is a later focus. */
function AiReviewerPanel({ data, now }: { data: ModelInsights; now: number }) {
  const t = data.targets;
  const buys = data.aiReviewer.buys;
  // The API reports the configured mode, not whether the reviewer runs: the mode defaults to
  // "shadow" while nothing runs without an API key. No review at all in the window reads as off.
  const running =
    data.curator.aiReviewMode !== "off" &&
    (data.aiReviewer.allReviewed.calls > 0 || buys.calls > 0 || data.recentAiReviews.length > 0);
  return (
    <section className="panel secondary">
      <details>
        <summary className="row between">
          <span className="row">
            <RobotIcon size={15} />
            <strong>AI reviewer</strong>
            <span
              className="chip"
              title={
                running
                  ? `Running in ${data.curator.aiReviewMode} mode`
                  : data.curator.aiReviewMode === "off"
                    ? "Switched off"
                    : `Set to ${data.curator.aiReviewMode} mode, but it made no reviews in this window: it runs only with an API key set`
              }
            >
              {running ? data.curator.aiReviewMode : "off"}
            </span>
          </span>
          <span className="muted small">
            {buys.calls > 0
              ? `${buys.calls} buy calls · ${pct(buys.hitRate2xPct)} 2x · ${pct(buys.hitRate4xPct)} 4x`
              : "no calls in this window"}
          </span>
        </summary>
        <p className="muted small">
          A second opinion from Claude on each call the default feed makes. In shadow mode it records a buy /
          no-buy without blocking anything; in gate mode it holds back its no-buys once{" "}
          {data.curator.aiReviewMinGradedBuys} of its buys are graded and meet both targets.
          {!running &&
            " It is off: it runs only with an API key set, and it has made no calls in this window."}
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Calls</th>
                <th className="r">Made</th>
                <th className="r">Graded</th>
                <th className="r">2x</th>
                <th className="r">4x</th>
                <th className="r">10x</th>
              </tr>
            </thead>
            <tbody>
              <RateRow name="Buy calls" r={buys} />
              {data.aiReviewer.byDecision
                .filter((d) => d.decision === "no_buy")
                .map((d) => (
                  <RateRow key={`nb-${d.mode}`} name={`No-buy calls (${d.mode})`} r={d} />
                ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">
          Lift over the picks it reviewed:{" "}
          <strong>
            {data.aiReviewer.liftPts === null
              ? "–"
              : `${data.aiReviewer.liftPts > 0 ? "+" : ""}${data.aiReviewer.liftPts} pts`}
          </strong>
          {" · "}odds error (Brier, lower is better, 0.25 is a coin):{" "}
          <strong>{brier(data.aiReviewer.brier)}</strong> vs the model's own{" "}
          <strong>{brier(data.aiReviewer.curatorBrier)}</strong>
        </p>
        <AiJudgeLoop judge={data.aiJudge} now={now} />
        {data.aiReviewer.probability2xBands.length > 0 && (
          <>
            <h4>Do its odds hold up?</h4>
            <TargetBars
              aLabel="Actual 2x rate"
              bLabel="Actual 4x rate"
              aTarget={t.hitRate2xPct}
              bTarget={t.hitRate4xPct}
              data={data.aiReviewer.probability2xBands.map((b) => ({
                label: `${b.band}-${b.band + 10}%`,
                a: b.hitRate2xPct,
                b: b.hitRate4xPct,
                sub: `${b.graded} graded`,
                shortSub: `${b.graded}`,
              }))}
            />
          </>
        )}
        {data.recentAiReviews.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Token</th>
                  <th>When</th>
                  <th>Call</th>
                  <th className="r">P(2x)</th>
                  <th className="r">Mcap</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {data.recentAiReviews.slice(0, 10).map((r) => (
                  <tr key={r.id} title={r.reasoning ?? undefined}>
                    <td>
                      <a
                        href={`https://dexscreener.com/solana/${r.token.mintAddress}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {tokenLabel(r.token)}
                      </a>
                    </td>
                    <td className="muted">{ago(r.createdAt, now)}</td>
                    <td>
                      <span
                        className={`badge ${r.decision === "buy" ? "good" : r.decision === "no_buy" ? "bad" : "neutral"}`}
                      >
                        {r.decision === "buy" ? "BUY" : r.decision === "no_buy" ? "NO BUY" : "error"}
                      </span>
                    </td>
                    <td className="r num">
                      {r.probability2x === null ? "–" : `${(r.probability2x * 100).toFixed(0)}%`}
                    </td>
                    <td className="r num">{usd(r.anchorMcapUsd)}</td>
                    <td>{OUTCOME_TEXT[r.outcome]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>
    </section>
  );
}

const brier = (v: number | null | undefined) => (v === null || v === undefined ? "–" : v.toFixed(3));

const PLAYBOOK_STATUS: Record<AiJudgeState["playbooks"][number]["status"], string> = {
  active: "in use",
  candidate: "on test",
  retired: "replaced",
  rejected: "lost its test",
};

/**
 * The reviewer's learning loop: playbook versions (lessons learned from its graded calls), each
 * judged on a replay of recent alerts it never saw, and the learned blend gate mode can use.
 */
function AiJudgeLoop({ judge, now }: { judge: AiJudgeState; now: number }) {
  if (judge.playbooks.length === 0 && judge.replays.length === 0 && judge.blend === null) return null;
  const pending = judge.replays.find((r) => r.status === "submitted");
  return (
    <>
      <h4>How it is learning</h4>
      <p className="muted small">
        Once a day Claude reviews its graded calls into new playbooks, and a new one takes over only if it
        beats the current one on a replay of recent alerts it never saw.
        {pending && ` A ${pending.purpose} replay is running (started ${ago(pending.createdAt, now)}).`}
      </p>
      {judge.playbooks.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Playbook</th>
                <th>Status</th>
                <th className="r">Replay buys</th>
                <th className="r">2x</th>
                <th className="r">4x</th>
                <th className="r">Lift</th>
                <th className="r">Score</th>
              </tr>
            </thead>
            <tbody>
              {judge.playbooks.map((p) => (
                <tr key={p.id} title={p.rationale ?? undefined}>
                  <td>v{p.version}</td>
                  <td>
                    <span
                      className={`badge ${p.status === "active" ? "good" : p.status === "rejected" ? "bad" : "neutral"}`}
                    >
                      {PLAYBOOK_STATUS[p.status]}
                    </span>
                  </td>
                  <td className="r num">{p.metrics ? p.metrics.buys : "–"}</td>
                  <td className="r num">{pct(p.metrics?.buyWinRatePct, 1)}</td>
                  <td className="r num">{pct(p.metrics?.buyGoalRatePct, 1)}</td>
                  <td className="r num">
                    {p.metrics?.liftPts === null || p.metrics?.liftPts === undefined
                      ? "–"
                      : `${p.metrics.liftPts > 0 ? "+" : ""}${p.metrics.liftPts.toFixed(1)}`}
                  </td>
                  <td className="r num">{p.metrics?.score ?? "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {judge.playbooks.find((p) => p.status === "active" && p.text) && (
        <details>
          <summary className="muted small">Current playbook (admins)</summary>
          <pre className="small">{judge.playbooks.find((p) => p.status === "active")?.text || "(empty)"}</pre>
        </details>
      )}
      {judge.blend && (
        <p className="muted small">
          Learned blend of its odds and the model's ({judge.blend.metrics.rows} graded reviews):{" "}
          {judge.blend.usable ? <strong>in use for gate mode</strong> : <strong>not in use</strong>} -{" "}
          {judge.blend.metrics.reason}.
        </p>
      )}
    </>
  );
}

function RateRow({ name, r }: { name: string; r: GradedRates }) {
  return (
    <tr>
      <td>{name}</td>
      <td className="r num">{r.calls.toLocaleString()}</td>
      <td className="r num">{r.graded.toLocaleString()}</td>
      <td className="r num">{pct(r.hitRate2xPct, 1)}</td>
      <td className="r num">{pct(r.hitRate4xPct, 1)}</td>
      <td className="r num">{pct(r.hitRate10xPct, 1)}</td>
    </tr>
  );
}

function PipelineStage({
  Icon,
  title,
  caption,
  count,
  rate,
}: {
  Icon: typeof RadarIcon;
  title: string;
  caption: string;
  count: number | undefined;
  rate: number | null | undefined;
}) {
  return (
    <li className="stage">
      <span className="stage-icon">
        <Icon size={16} />
      </span>
      <span className="stage-title">{title}</span>
      <span className="stage-rate num">{pct(rate, 1)}</span>
      <span className="stage-caption">
        {count === undefined ? "" : `${count.toLocaleString()} `}
        {caption}
      </span>
      <ArrowRightIcon size={16} className="stage-arrow" />
    </li>
  );
}
