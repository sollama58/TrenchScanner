import { useState } from "react";
import {
  api,
  put,
  type GradedRates,
  type Leaderboard,
  type LeaderboardEntry,
  type ModelInsights,
  type ModelRun,
} from "../api";
import { HBarChart, Skeleton, TargetBars } from "../components/Charts";
import { ArrowRightIcon, BrainIcon, RadarIcon, RobotIcon, TargetIcon } from "../components/Icons";
import { usePolling, useNow } from "../hooks";
import { ago, pct, tokenLabel, usd } from "../format";

const WINDOWS = [7, 30, 90] as const;

const LEARNER_NAME = { logistic: "Logistic regression", gbdt: "Gradient-boosted trees" } as const;

const ROLE_LABEL: Record<LeaderboardEntry["role"], string> = {
  stacked: "Stacked on the others",
  rules: "Hand-tuned rules",
  learner: "Trained model",
};

/**
 * The Model tab: the curator contest. Several models train on the same graded history, each calls
 * on its own feed, a leaderboard ranks them on one composite score, and the Consensus learns from
 * the rest. The AI reviewer sits at the bottom, collapsed - it is a later focus.
 */
export function ModelTab() {
  const now = useNow(60_000);
  const [days, setDays] = useState<(typeof WINDOWS)[number]>(30);
  const [pick, setPick] = useState(0);
  const insights = usePolling(
    () => api<ModelInsights>(`/curated/insights?days=${days}`),
    120_000,
    String(days),
  );
  const board = usePolling(
    () => api<Leaderboard>(`/curated/models?days=${days}`),
    120_000,
    `${days}:${pick}`,
  );

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
  const base = data.samples.byKind.find((k) => k.kind === "event");
  const selected = lb.entries.find((e) => e.id === lb.selectedModel) ?? null;
  const consensus = lb.entries.find((e) => e.role === "stacked") ?? null;
  const contenders = lb.entries.filter((e) => e.role !== "stacked");
  const leader = lb.entries[0] ?? null;
  const bestContender = [...contenders].sort(
    (a, b) => (b.composite.live.winRatePct ?? -1) - (a.composite.live.winRatePct ?? -1),
  )[0];
  const useModel = async (id: string | null) => {
    await put("/curated/model", { model: id });
    setPick((n) => n + 1);
  };

  return (
    <div className="stack">
      <section className="panel hero">
        <div className="hero-top">
          <div>
            <span className="eyebrow">
              <BrainIcon size={13} /> The contest
            </span>
            <h2 className="hero-title">
              <span className="grad">{lb.entries.length} models</span> compete for your feed
            </h2>
            <p className="muted">
              Each one trains on the same graded history every few hours, makes its own calls on its own feed,
              and is graded the same way: {data.rules.win}. The <strong>Consensus</strong> doesn't read the
              market directly; it learns how far to trust each of the others. Your feed shows{" "}
              <strong>{selected?.name ?? "–"}</strong>
              {lb.followsDefault ? " (the default)" : ""}.
              {leader && leader.composite.score !== null && (
                <>
                  {" "}
                  Leading the board: <strong>{leader.name}</strong> at{" "}
                  <span className="num">{leader.composite.score.toFixed(0)}</span>.
                </>
              )}
            </p>
          </div>
          <div className="segmented" role="tablist" aria-label="Window">
            {WINDOWS.map((w) => (
              <button key={w} className={w === days ? "on" : ""} onClick={() => setDays(w)}>
                {w}d
              </button>
            ))}
          </div>
        </div>

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
            caption={bestContender ? `best: ${bestContender.name}` : "calls"}
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
            <span className="stage-caption">hit 2x · {t.hitRate4xPct}% hit 4x</span>
          </li>
        </ol>
        <p className="faint small">
          Live 2x rate over the last {days} days at each step. Fill: {data.rules.fill}.
        </p>
      </section>

      <LeaderboardPanel board={lb} days={days} onUse={useModel} />

      <HowItWorks board={lb} />

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
                {data.importance.learner === "gbdt"
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

        <section className="panel">
          <span className="eyebrow">Baseline</span>
          <h3>What a model has to beat</h3>
          <p className="muted small">
            Picking at random from the moments the models decide on would have earned this. Every model's hit
            rate is only worth something above it.
          </p>
          {base ? (
            <div className="family-figs">
              <div>
                <label>Moments</label>
                <span className="num">{base.calls.toLocaleString()}</span>
              </div>
              <div>
                <label>Base 2x</label>
                <span className="num">{pct(base.hitRate2xPct, 1)}</span>
              </div>
              <div>
                <label>Base 4x</label>
                <span className="num">{pct(base.hitRate4xPct, 1)}</span>
              </div>
            </div>
          ) : (
            <p className="empty">No graded decision moments in this window yet.</p>
          )}
        </section>
      </div>

      <AiReviewerPanel data={data} now={now} />
    </div>
  );
}

function runName(run: ModelRun | undefined): string | null {
  return run?.contestantName ?? null;
}

const STATUS_TEXT: Record<LeaderboardEntry["status"], { text: string; tone: string }> = {
  calling: { text: "calling", tone: "good" },
  silent: { text: "no cutoff yet", tone: "neutral" },
  untrained: { text: "not trained yet", tone: "neutral" },
};

function LeaderboardPanel({
  board,
  days,
  onUse,
}: {
  board: Leaderboard;
  days: number;
  onUse: (id: string | null) => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const use = async (id: string | null) => {
    setBusy(id ?? "default");
    try {
      await onUse(id);
    } finally {
      setBusy(null);
    }
  };
  const t = board.targets;
  return (
    <section className="panel">
      <header className="section-head">
        <div>
          <span className="eyebrow">Leaderboard</span>
          <h3>Who's calling it best, last {days} days</h3>
          <p className="muted small">{board.scoring.summary}</p>
        </div>
        {!board.followsDefault && (
          <button className="ghost" disabled={busy !== null} onClick={() => void use(null)}>
            Back to the default
          </button>
        )}
      </header>
      <div className="table-wrap">
        <table className="leaderboard">
          <thead>
            <tr>
              <th className="r">#</th>
              <th>Model</th>
              <th>Score</th>
              <th className="r">Live calls</th>
              <th className="r">2x</th>
              <th className="r">4x</th>
              <th className="r" title="Average doublings per call">
                Avg doublings
              </th>
              <th className="r">Backtest 2x / 4x</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {board.entries.map((e) => {
              const mine = e.id === board.selectedModel;
              const { live, exam } = e.composite;
              return (
                <tr key={e.id} className={mine ? "selected" : ""}>
                  <td className="r num">{e.rank}</td>
                  <td className="model-cell">
                    <div className="row">
                      <strong>{e.name}</strong>
                      {e.isDefault && <span className="chip chip-model">default</span>}
                      {mine && <span className="chip">your feed</span>}
                    </div>
                    <small className="muted">
                      {ROLE_LABEL[e.role]} · {e.description}
                    </small>
                  </td>
                  <td>
                    <ScoreBar score={e.composite.score} liveWeight={e.composite.liveWeight} />
                  </td>
                  <td className="r num">
                    {live.calls}
                    {live.calls > live.graded && <span className="faint"> ({live.graded} graded)</span>}
                  </td>
                  <td className={`r num ${rateTone(live.winRatePct, t.hitRate2xPct)}`}>
                    {pct(live.winRatePct)}
                  </td>
                  <td className={`r num ${rateTone(live.goalRatePct, t.hitRate4xPct)}`}>
                    {pct(live.goalRatePct)}
                  </td>
                  <td className="r num">{doublings(live.avgReturnDoublings)}</td>
                  <td className="r num muted">
                    {exam.graded > 0 ? `${pct(exam.winRatePct)} / ${pct(exam.goalRatePct)}` : "–"}
                    {exam.graded > 0 && <span className="faint"> · {exam.graded}</span>}
                  </td>
                  <td>
                    <span className={`badge ${STATUS_TEXT[e.status].tone}`}>
                      {STATUS_TEXT[e.status].text}
                    </span>
                  </td>
                  <td className="r">
                    {!mine && (
                      <button
                        className="ghost small-btn"
                        disabled={busy !== null}
                        onClick={() => void use(e.id)}
                      >
                        Use
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="faint small">
        Avg doublings is the average return per call: a 2x counts 1, a 4x counts 2, a miss or a stop-out 0.
        Backtest figures are the latest training run's walk-forward exam, with the number of calls it made.
      </p>
    </section>
  );
}

function rateTone(value: number | null, target: number): string {
  if (value === null) return "";
  return value >= target ? "up" : "";
}

function doublings(value: number | null): string {
  if (value === null) return "–";
  return value.toFixed(2);
}

function ScoreBar({ score, liveWeight }: { score: number | null; liveWeight: number }) {
  if (score === null) return <span className="faint">–</span>;
  return (
    <div
      className="score-bar"
      title={`${Math.round(liveWeight * 100)}% from live calls, ${Math.round((1 - liveWeight) * 100)}% from the backtest`}
    >
      <span className="score-track">
        <span className="score-fill" style={{ width: `${Math.max(2, Math.min(100, score))}%` }} />
      </span>
      <span className="num">{score.toFixed(0)}</span>
    </div>
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
          moments: what a token looked like, and whether it then hit 2x within the hour of a realistic fill.
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
          <strong>Battle.</strong> Every model calls on its own feed, paced and graded the same way. The
          leaderboard score is {Math.round(w.winRate * 100)}% 2x rate, {Math.round(w.goalRate * 100)}% 4x rate
          and {Math.round(w.avgReturn * 100)}% average return, judged against the targets with small samples
          discounted. It starts from the backtest and shifts to live calls as they're graded (half and half at{" "}
          {board.scoring.livePivotCalls}).
        </li>
        <li>
          <strong>Consensus.</strong> A second-order model trained on the others' out-of-sample calls: it
          learns which models to trust and when they agree, and gets its own exam on later weeks than it
          trained on. It's the default feed once its exam gives it a cutoff; until then the default is Rules.
        </li>
      </ol>
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
            {run.precisionCalibration?.support
              ? `; the live cutoff made ${run.precisionCalibration.support} exam calls at ${pct(
                  run.precisionCalibration.winRatePct,
                )} / ${pct(run.precisionCalibration.goalRatePct)}`
              : ""}
            .
          </p>
          {run.precisionCurve.length > 0 ? (
            <TargetBars
              aLabel="Doubled (2x)"
              bLabel="Reached 4x"
              aTarget={targets.hitRate2xPct}
              bTarget={targets.hitRate4xPct}
              data={run.precisionCurve.map((p, i) => ({
                // Slices too thin to hold one call are skipped from the front, so align from the end.
                label: `Top ${CURVE_SLICES[CURVE_SLICES.length - run.precisionCurve.length + i] ?? "?"}`,
                a: p.winRatePct,
                b: p.goalRatePct,
                sub: `${p.alerts} calls`,
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
                      <td className="r num">{pct(r.precisionCalibration?.winRatePct)}</td>
                      <td className="r num">{pct(r.precisionCalibration?.goalRatePct)}</td>
                      <td className="r num">{r.precisionCalibration?.support ?? "–"}</td>
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

/** precisionCurve's fixed slices, in the order trainer.ts writes them. */
const CURVE_SLICES = ["1%", "2%", "5%", "10%", "20%", "50%"];

const OUTCOME_TEXT: Record<ModelInsights["recentAiReviews"][number]["outcome"], string> = {
  pending: "◷ in its hour",
  won: "✓ 2x",
  won4x: "✓✓ 4x",
  missed: "✕ missed",
  stopped: "✕ stopped out",
  unknown: "–",
};

/** The AI reviewer, kept small and collapsed: it reviews the default feed's calls and is a later focus. */
function AiReviewerPanel({ data, now }: { data: ModelInsights; now: number }) {
  const t = data.targets;
  const buys = data.aiReviewer.buys;
  return (
    <section className="panel secondary">
      <details>
        <summary className="row between">
          <span className="row">
            <RobotIcon size={15} />
            <strong>AI reviewer</strong>
            <span className="chip">{data.curator.aiReviewMode}</span>
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
          {buys.calls === 0 && " It needs ANTHROPIC_API_KEY on the worker."}
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

function RateRow({ name, r }: { name: string; r: GradedRates }) {
  return (
    <tr>
      <td>{name}</td>
      <td className="r num">{r.calls.toLocaleString()}</td>
      <td className="r num">{r.graded.toLocaleString()}</td>
      <td className="r num">{pct(r.hitRate2xPct, 1)}</td>
      <td className="r num">{pct(r.hitRate4xPct, 1)}</td>
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
