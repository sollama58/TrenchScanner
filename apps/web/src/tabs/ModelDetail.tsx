import { useEffect, useRef, useState } from "react";
import type {
  CuratedPage,
  GradedRates,
  Leaderboard,
  LeaderboardEntry,
  ModelRun,
  ModelWeights,
  ModelRunHistory,
  RecordSummary,
} from "../api";
import { IN_SAMPLE_LABEL, runExamRates } from "../api";
import { CutoffCurve, HBarChart } from "../components/Charts";
import { CloseIcon } from "../components/Icons";
import { cutoffPoints, perHourText } from "../cutoffCurve";
import { toggledModels } from "../components/ModelPicker";
import { ScoreBar } from "../components/ScoreBar";
import { usePolling } from "../hooks";
import { ago, multiple, pct, signedPct, stakes, tokenLabel, usd } from "../format";
import { outcomeAt, outcomeBadge } from "../outcome";
import {
  LEARNER_NAME,
  ROLE_LABEL,
  RulesInUse,
  STATUS_TEXT,
  WINDOWS,
  windowLong,
  windowShort,
  bestReturnTitle,
  doublings,
  profitTone,
  rateTitle,
  rateTone,
  recordSince,
  shortDate as shortMonthDay,
} from "./modelShared";
import { MIN_GRADED_FOR_RATE, RULE_NOTE } from "../rates";

/** Latest calls the detail view lists. */
const RECENT_CALLS = 8;

/** Training runs listed before "Show all". */
const RUN_ROWS = 8;

/**
 * One model, everything about it, in a native modal dialog (a centered panel on desktop, a sheet
 * from the bottom on phones): its record over the picked window against the random-pick baseline,
 * the same record over every window, live against its backtest exam, what it weighs most, its
 * cutoff curve, its latest exam fold by fold, its training runs and the recipes that held its seat
 * before, and its latest calls.
 */
export function ModelDetailModal({
  entry,
  board,
  base,
  runs,
  days,
  api,
  guest,
  now,
  onClose,
  onSetModels,
  refreshing,
}: {
  /** The model shown; null keeps the dialog closed. */
  entry: LeaderboardEntry | null;
  board: Leaderboard;
  /** The random-pick baseline over the same window (insights samples, "event" kind). */
  base: GradedRates | null;
  runs: ModelRun[];
  days: number;
  /** "/curated" or "/guest": where the window boards come from. */
  api: string;
  guest: boolean;
  now: number;
  onClose: () => void;
  onSetModels: (models: string[] | null) => Promise<void>;
  refreshing: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const open = entry !== null;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="about-modal sheet-modal model-modal"
      aria-labelledby="model-detail-title"
      onClose={onClose}
      // A click on the backdrop lands on the dialog element itself; clicks inside land on its content.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {entry && (
        <ModelDetail
          key={entry.id}
          entry={entry}
          board={board}
          base={base}
          runs={runs}
          days={days}
          api={api}
          guest={guest}
          now={now}
          onClose={onClose}
          onSetModels={onSetModels}
          refreshing={refreshing}
        />
      )}
    </dialog>
  );
}

function ModelDetail({
  entry: e,
  board,
  base,
  runs,
  days,
  api,
  guest,
  now,
  onClose,
  onSetModels,
  refreshing,
}: {
  entry: LeaderboardEntry;
  board: Leaderboard;
  base: GradedRates | null;
  runs: ModelRun[];
  days: number;
  api: string;
  guest: boolean;
  now: number;
  onClose: () => void;
  onSetModels: (models: string[] | null) => Promise<void>;
  refreshing: boolean;
}) {
  const t = board.targets;
  const tenXGoal = board.scoring.tenXTargetPct ?? 25;
  const { live, exam } = e.composite;
  const mine = board.selectedModels.includes(e.id);
  const onlyOne = mine && board.selectedModels.length === 1;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSetModels(toggledModels(board, e.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // Its own run history; the field-wide recent runs stand in until that loads.
  const history = usePolling<ModelRunHistory>(`${api}/models/${encodeURIComponent(e.id)}/runs`, 300_000);
  const myRuns = history.data?.runs ?? runs.filter((r) => r.contestant === e.id);
  const [allRuns, setAllRuns] = useState(false);
  const latestRun = myRuns[0] ?? null;
  // The held-out exam figure, as the Previous iterations table below shows it (the in-sample
  // calibration only when a run has no held-out exam).
  const latestExam = latestRun ? runExamRates(latestRun) : null;
  const seat = board.evolution.history.filter((h) => h.slot === e.id);
  const basis = e.composite.basis ?? null;
  const weights = usePolling<ModelWeights>(`${api}/models/${encodeURIComponent(e.id)}/weights`, 600_000);

  return (
    <div className="about-body model-detail">
      <header className="about-head">
        <div className="model-detail-title">
          <span className="eyebrow">
            #{e.rank} of {board.entries.length} · {ROLE_LABEL[e.role]}
          </span>
          <h2 id="model-detail-title">{e.name}</h2>
        </div>
        <button className="ghost icon-btn" onClick={onClose} aria-label="Close">
          <CloseIcon size={16} />
        </button>
      </header>
      <div className="row model-detail-chips">
        <span className={`badge ${STATUS_TEXT[e.status].tone}`}>{STATUS_TEXT[e.status].text}</span>
        {e.isBest && (
          <span className="badge info" title={bestReturnTitle(board, now)}>
            best 24h return
          </span>
        )}
        {e.isDefault && <span className="badge info">default feed</span>}
        {mine && <span className="badge">{guest ? "guest feed" : "in your feed"}</span>}
        {e.composite.warmingUp && <span className="badge">warming up</span>}
      </div>
      <p className="muted small">{e.summary ?? e.description}</p>

      <div className="model-detail-score">
        <ScoreBar score={e.composite.score} band={e.composite.band ?? null} title="Score, 0 to 100" />
        {e.scoreExplained && <p className="faint small">{e.scoreExplained}</p>}
      </div>

      <h3>Last {windowLong(days)}, live</h3>
      <div className="model-figs">
        {/* The 2x lift is the board's hour-matched "vs market", the same figure the leaderboard
            ranks on; the 4x and 10x have no hour-matched market, so they show the window's
            random-pick rate beside them without a multiple. */}
        <RateFig
          label="Doubled (2x)"
          rate={live.winRatePct}
          goal={t.hitRate2xPct}
          graded={live.graded}
          lift={e.vsMarket?.lift ?? null}
          baseRate={e.vsMarket?.marketRatePct ?? null}
          baseLabel="market in its hours"
        />
        <RateFig
          label="Hit 4x"
          rate={live.goalRatePct}
          goal={t.hitRate4xPct}
          graded={live.graded}
          lift={null}
          baseRate={base?.hitRate4xPct ?? null}
          baseLabel="random"
        />
        <RateFig
          label="Hit 10x"
          rate={live.tenXRatePct ?? null}
          goal={tenXGoal}
          graded={live.graded}
          lift={null}
          baseRate={base?.hitRate10xPct ?? null}
          baseLabel="random"
          digits={1}
        />
        <div className="model-fig">
          <label>Avg profit per call</label>
          <span className={`num ${profitTone(live.avgSimReturnPct)}`}>{signedPct(live.avgSimReturnPct)}</span>
          <small className="faint">
            {live.totalSimReturnPct != null
              ? `${stakes(live.totalSimReturnPct)} over ${live.simCalls ?? live.graded} calls`
              : "No settled calls yet"}
          </small>
        </div>
      </div>
      <p className="faint small">
        {live.calls} call{live.calls === 1 ? "" : "s"}, {live.graded} graded
        {live.avgReturnDoublings != null ? ` · ${doublings(live.avgReturnDoublings)} doublings per call` : ""}
        {e.highConviction
          ? ` · high-conviction calls doubled ${pct(e.highConviction.winRatePct)} of ${e.highConviction.graded}`
          : ""}
        {recordSince(e, board) ? `, since it took its seat on ${shortMonthDay(recordSince(e, board)!)}` : ""}.
        The 2x tile&apos;s small figure is its lift, the board&apos;s &quot;vs market&quot;: how many times
        the market&apos;s 2x rate in the same hours it hit. The 4x and 10x show the random-pick rate over the
        window. {RULE_NOTE}
      </p>
      {board.exitPlan && <p className="faint small">Profit follows one fixed exit plan: {board.exitPlan}</p>}

      <h3>Every window</h3>
      <WindowsTable entry={e} api={api} days={days} targets={t} />

      <h3>Live against its exam</h3>
      <div className="table-wrap">
        <table className="model-compare">
          <thead>
            <tr>
              <th />
              <th className="r">Calls</th>
              <th className="r">2x</th>
              <th className="r">4x</th>
              <th className="r">10x</th>
              <th className="r">Avg profit</th>
            </tr>
          </thead>
          <tbody>
            <RecordRow name={`Live, ${windowShort(days)}`} r={live} t={t} />
            <RecordRow name="Backtest exam" r={exam} t={t} />
          </tbody>
        </table>
      </div>
      {basis && (
        <p className="faint small">
          The score rests on {basis.evidenceCalls.toLocaleString()} calls&apos; worth of evidence:{" "}
          {basis.liveCalls.toLocaleString()} graded live calls and {basis.backtestCalls.toLocaleString()} from
          the backtest ({Math.round(e.composite.liveWeight * 100)}% live). Proven rates after the prior
          misses: 2x {pct(basis.proven2xPct)}, 4x {pct(basis.proven4xPct)}
          {basis.proven10xPct != null ? `, 10x ${pct(basis.proven10xPct, 1)}` : ""}.
        </p>
      )}

      <Weightings weights={weights.data} error={weights.error !== null} role={e.role} />

      <h3>Its cutoffs</h3>
      <CutoffSection run={latestRun} weights={weights.data} targets={t} />

      {e.rules && (
        <>
          <h3>The checks it runs</h3>
          <RulesInUse rules={e.rules} now={now} />
        </>
      )}

      <h3>Latest exam</h3>
      {latestRun ? (
        <>
          <p className="muted small">
            Trained {ago(latestRun.createdAt, now)} as {LEARNER_NAME[latestRun.learner].toLowerCase()} on{" "}
            {latestRun.trainingRows.toLocaleString()} graded moments.
            {latestExam?.calls
              ? latestExam.heldOut
                ? ` At its live cutoff it made ${latestExam.calls} exam calls: ${pct(
                    latestExam.winRatePct,
                  )} doubled, ${pct(latestExam.goalRatePct)} hit 4x.`
                : ` This run stored no held-out exam. At its live cutoff, ${IN_SAMPLE_LABEL}: ${latestExam.calls} calls, ${pct(
                    latestExam.winRatePct,
                  )} doubled, ${pct(latestExam.goalRatePct)} hit 4x, on the same calls the cutoff was picked on, so it reads high.`
              : ""}
            {latestRun.verdict ? ` ${latestRun.verdict.reason}` : ""}
          </p>
          {latestRun.folds.length > 0 && (
            <div className="table-wrap">
              <table className="model-compare">
                <thead>
                  <tr>
                    <th>Test window</th>
                    <th className="r">Random 2x</th>
                    <th className="r">Calls</th>
                    <th className="r">2x</th>
                    <th className="r">4x</th>
                  </tr>
                </thead>
                <tbody>
                  {latestRun.folds.map((f) => {
                    const side = latestRun.contestant === "rules" ? f.heuristic : f.model;
                    return (
                      <tr key={f.testFrom}>
                        <td className="muted">
                          {shortDate(f.testFrom)} – {shortDate(f.testTo)}
                        </td>
                        <td className="r num faint">{pct(f.baseWinRatePct, 1)}</td>
                        <td className="r num">{side.emitted}</td>
                        <td
                          className={`r num ${rateTone(side.precisionPct, t.hitRate2xPct, side.emitted)}`}
                          title={rateTitle(side.precisionPct, side.emitted)}
                        >
                          {pct(side.precisionPct)}
                        </td>
                        <td
                          className={`r num ${rateTone(side.goalPrecisionPct, t.hitRate4xPct, side.emitted)}`}
                        >
                          {pct(side.goalPrecisionPct)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        <p className="faint small">
          {e.model
            ? `Trained ${ago(e.model.trainedAt, now)} on ${e.model.trainingRows.toLocaleString()} graded moments; that run is older than the history kept here.`
            : e.role === "rules"
              ? "Rules don't train; their checks are scored on the same exam as everyone else."
              : "Not trained yet."}
        </p>
      )}

      <h3>Previous iterations</h3>
      {myRuns.length > 1 ? (
        <>
          <p className="faint small">
            Every training run sits a fresh walk-forward exam; the active one is calling now. Hover a row for
            its verdict.
          </p>
          <div className="table-wrap">
            <table className="model-compare">
              <thead>
                <tr>
                  <th>Trained</th>
                  <th className="r">Rows</th>
                  <th>Status</th>
                  <th className="r">Exam calls</th>
                  <th className="r">2x</th>
                  <th className="r">4x</th>
                </tr>
              </thead>
              <tbody>
                {(allRuns ? myRuns : myRuns.slice(0, RUN_ROWS)).map((r) => (
                  <tr key={r.id} title={r.verdict?.reason}>
                    <td className="muted">{ago(r.createdAt, now)}</td>
                    <td className="r num">{r.trainingRows.toLocaleString()}</td>
                    <td>
                      <span className={`chip ${r.status === "active" ? "chip-model" : ""}`}>{r.status}</span>
                    </td>
                    <td className="r num">
                      {runExamRates(r).calls ?? "–"}
                      {runExamRates(r).calls != null && !runExamRates(r).heldOut && (
                        <span className="faint" title={IN_SAMPLE_LABEL}>
                          {" "}
                          in-sample
                        </span>
                      )}
                    </td>
                    <td className="r num">{pct(runExamRates(r).winRatePct)}</td>
                    <td className="r num">{pct(runExamRates(r).goalRatePct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {myRuns.length > RUN_ROWS && (
            <button className="ghost small" onClick={() => setAllRuns((v) => !v)}>
              {allRuns ? "Show fewer" : `Show all ${myRuns.length} runs`}
            </button>
          )}
        </>
      ) : (
        <p className="faint small">
          {myRuns.length === 1 ? "One training run so far." : "No training runs yet."}
        </p>
      )}
      {seat.length > 0 ? (
        <ol className="evo-list model-seat">
          {seat.map((h) => (
            <li
              key={`${h.slot}:${h.generation}:${String(h.bornAt)}`}
              className={h.retiredAt ? "retired" : ""}
            >
              <div className="row">
                <strong>{h.name}</strong>
                <span className={`chip ${h.retiredAt ? "" : "chip-model"}`}>
                  {h.retiredAt
                    ? `replaced ${ago(h.retiredAt, now)}`
                    : h.generation === 0
                      ? "founding recipe"
                      : "in the seat now"}
                </span>
                <span className="faint small">
                  {h.generation === 0 ? "founded" : `generation ${h.generation}, seated`} {ago(h.bornAt, now)}
                </span>
                {h.examScore !== null && (
                  <span className="faint small num">exam {h.examScore.toFixed(0)}</span>
                )}
              </div>
              <small className="muted">{h.description}</small>
              {h.parentName && <small className="faint">Bred from {h.parentName}</small>}
              {h.retiredReason && <small className="faint">{h.retiredReason}</small>}
            </li>
          ))}
        </ol>
      ) : (
        e.lane && (
          <p className="faint small">
            {e.lane.generation === 0
              ? `The founding recipe, in its seat since ${ago(e.lane.bornAt, now)}.`
              : `Generation ${e.lane.generation}${e.lane.parentName ? `, bred from ${e.lane.parentName}` : ""}, in its seat since ${ago(e.lane.bornAt, now)}.`}
          </p>
        )
      )}

      {!guest && <RecentCalls modelId={e.id} now={now} />}

      {!guest && (
        <footer className="model-detail-foot">
          {error && <p className="error small">Couldn&apos;t change your feed: {error}</p>}
          <label className="in-feed" title={onlyOne ? "Your feed needs at least one model" : undefined}>
            <input
              type="checkbox"
              checked={mine}
              disabled={busy || refreshing || onlyOne}
              onChange={() => void toggle()}
            />
            Show its calls in my feed
          </label>
        </footer>
      )}
    </div>
  );
}

/**
 * What the model leans on: a learner's top inputs by share of its score's total push over recent
 * decision moments, or a combiner's members by their weight (consensus) or how often each backed
 * its calls. Rules has neither; its checks are listed below instead.
 */
function Weightings({
  weights: w,
  error,
  role,
}: {
  weights: ModelWeights | null;
  error: boolean;
  role: LeaderboardEntry["role"];
}) {
  if (role === "rules") return null;
  const heading = <h3>What it weighs most</h3>;
  if (!w) {
    return (
      <>
        {heading}
        <p className="faint small">{error ? "Couldn't load its weightings." : "Loading…"}</p>
      </>
    );
  }
  if (w.inputs && w.inputs.length > 0) {
    // Only a linear model's inputs push one way throughout.
    const linear = w.inputs.some((f) => f.direction !== null);
    return (
      <>
        {heading}
        <p className="muted small">
          Each signal&apos;s share of the push on its score over the last{" "}
          {(w.inputSample?.rows ?? 0).toLocaleString()} decision moments.{" "}
          {linear
            ? "▲ more of it pushes toward a call, ▼ less of it does."
            : "▲ it pushed toward a call on the coins it called, ▼ against."}
        </p>
        <HBarChart
          data={w.inputs.map((f) => {
            const dir = f.direction ?? (f.onCalls == null || f.onCalls === 0 ? null : f.onCalls > 0 ? 1 : -1);
            return {
              label: `${dir === 1 ? "▲ " : dir === -1 ? "▼ " : ""}${f.label}`,
              value: f.sharePct,
              display: `${f.sharePct.toFixed(1)}%`,
            };
          })}
        />
      </>
    );
  }
  if (w.members && w.members.length > 0) {
    const weighted = w.members.some((m) => m.weightPct !== null);
    const rows = [
      ...w.members.map((m) => ({
        label: `${weighted ? (m.direction === 1 ? "▲ " : m.direction === -1 ? "▼ " : "") : ""}${m.name}`,
        value: (weighted ? m.weightPct : m.backingPct) ?? 0,
        detail: m.callsTopPct !== null ? `calls the top ${m.callsTopPct}% on its own` : undefined,
      })),
      ...(w.otherSignals ?? []).map((o) => ({
        label: `${o.direction === 1 ? "▲ " : "▼ "}${o.label}`,
        value: o.weightPct,
        detail: undefined,
      })),
    ].sort((a, b) => b.value - a.value);
    const any = rows.some((r) => r.value > 0);
    return (
      <>
        {heading}
        {w.rule && <p className="muted small">{w.rule}</p>}
        {any ? (
          <>
            <p className="faint small">
              {weighted
                ? "Each signal's share of the weight in its combining model; ▲ a higher rank pushes toward a call."
                : `How often each member was calling too, on the ${w.inputSample?.calls ?? 0} recent moments it called.`}
            </p>
            <HBarChart
              data={rows.map((r) => ({
                label: r.label,
                value: r.value,
                display: `${r.value.toFixed(1)}%`,
                detail: r.detail,
              }))}
            />
          </>
        ) : (
          <p className="faint small">
            It hasn&apos;t called any of the recent moments its weightings are read on.
          </p>
        )}
      </>
    );
  }
  return (
    <>
      {heading}
      <p className="faint small">Appears once it has a trained model.</p>
    </>
  );
}

/**
 * Hit rate against how picky the cutoff is, from its latest training run's exam, with what each
 * cutoff would send per hour at today's flow of decision moments and the live cutoff marked.
 */
function CutoffSection({
  run,
  weights: w,
  targets: t,
}: {
  run: ModelRun | null;
  weights: ModelWeights | null;
  targets: Leaderboard["targets"];
}) {
  const points = run ? cutoffPoints(run.precisionCurve, w?.momentsPerHour ?? null) : [];
  if (points.length === 0) {
    return (
      <p className="faint small">
        {run
          ? "Its latest exam had too few calls to draw the curve."
          : "Appears after its first training run."}
      </p>
    );
  }
  const share = w?.cutoff.callsTopPct ?? null;
  const live = share !== null && share > 0 ? { sharePct: share, perHour: w!.callsPerHour24h } : null;
  // Graded at cutoffs set on other parts of the exam, as the Latest exam paragraph reads it.
  const exam = run ? runExamRates(run) : null;
  return (
    <>
      <p className="muted small">
        Calling only its most confident slice of decision moments trades volume for hit rate. Each point is
        its latest exam, out of sample; the figure under it is about how many calls an hour that cutoff would
        send at today&apos;s {w ? `${w.momentsPerHour.toLocaleString()} moments an hour` : "flow"}.
      </p>
      <CutoffCurve points={points} aTarget={t.hitRate2xPct} bTarget={t.hitRate4xPct} live={live} />
      <div className="table-wrap">
        <table className="model-compare">
          <thead>
            <tr>
              <th>Cutoff</th>
              <th className="r">Calls/hour</th>
              <th className="r">Exam calls</th>
              <th className="r">2x</th>
              <th className="r">4x</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.sharePct}>
                <td>Top {p.sharePct}%</td>
                <td className="r num">{perHourText(p.perHour)}</td>
                <td className="r num">{p.calls.toLocaleString()}</td>
                <td
                  className={`r num ${rateTone(p.winRatePct, t.hitRate2xPct, p.calls)}`}
                  title={rateTitle(p.winRatePct, p.calls)}
                >
                  {pct(p.winRatePct)}
                </td>
                <td className={`r num ${rateTone(p.goalRatePct, t.hitRate4xPct, p.calls)}`}>
                  {pct(p.goalRatePct)}
                </td>
              </tr>
            ))}
            {live && (
              <tr className="selected">
                <td>
                  Live: top {live.sharePct < 10 ? live.sharePct.toFixed(1) : Math.round(live.sharePct)}%
                </td>
                <td className="r num">{perHourText(live.perHour)}</td>
                <td className="r num">
                  {exam?.calls?.toLocaleString() ?? "–"}
                  {exam && exam.calls != null && !exam.heldOut && (
                    <span className="faint" title={IN_SAMPLE_LABEL}>
                      {" "}
                      in-sample
                    </span>
                  )}
                </td>
                <td
                  className={`r num ${rateTone(exam?.winRatePct ?? null, t.hitRate2xPct, exam?.calls ?? 0)}`}
                  title={rateTitle(exam?.winRatePct, exam?.calls ?? 0)}
                >
                  {pct(exam?.winRatePct)}
                </td>
                <td
                  className={`r num ${rateTone(exam?.goalRatePct ?? null, t.hitRate4xPct, exam?.calls ?? 0)}`}
                >
                  {pct(exam?.goalRatePct)}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {live && (
        <p className="faint small model-cutoff-note">
          The live row is its cutoff now and what it actually sent an hour over the last day, with its exam
          {exam?.heldOut === false
            ? ` figure ${IN_SAMPLE_LABEL}: picked on the same calls, so it reads high.`
            : " graded at cutoffs set on other parts of the exam."}
        </p>
      )}
      <p className="faint small">
        Slices on fewer than {MIN_GRADED_FOR_RATE} exam calls are muted as early, never green; hover a rate
        for its 90% range.
      </p>
    </>
  );
}

/**
 * A live rate as a tile: the rate (muted as early on too few graded calls, with its 90% range on
 * hover), its lift over the market where there is an hour-matched one, else the reference rate,
 * and the goal.
 */
function RateFig({
  label,
  rate,
  goal,
  graded,
  lift,
  baseRate,
  baseLabel,
  digits = 0,
}: {
  label: string;
  rate: number | null;
  goal: number;
  graded: number;
  lift: number | null;
  baseRate: number | null;
  baseLabel: string;
  digits?: number;
}) {
  return (
    <div className="model-fig">
      <label>{label}</label>
      <span className={`num ${rateTone(rate, goal, graded)}`} title={rateTitle(rate, graded)}>
        {pct(rate, digits)}
      </span>
      <small className="faint">
        {lift !== null ? (
          <>
            <strong className={lift >= 1 ? "up" : "down"}>{lift.toFixed(1)}x</strong> {baseLabel} (
            {pct(baseRate, 1)})
          </>
        ) : baseRate !== null ? (
          `${baseLabel} ${pct(baseRate, 1)}`
        ) : (
          "No baseline yet"
        )}
      </small>
      <small className="faint">Goal {goal}%</small>
    </div>
  );
}

function RecordRow({ name, r, t }: { name: string; r: RecordSummary; t: Leaderboard["targets"] }) {
  return (
    <tr>
      <td>{name}</td>
      <td className="r num">{r.graded.toLocaleString()}</td>
      <td
        className={`r num ${rateTone(r.winRatePct, t.hitRate2xPct, r.graded)}`}
        title={rateTitle(r.winRatePct, r.graded)}
      >
        {pct(r.winRatePct)}
      </td>
      <td className={`r num ${rateTone(r.goalRatePct, t.hitRate4xPct, r.graded)}`}>{pct(r.goalRatePct)}</td>
      <td className="r num">{pct(r.tenXRatePct, 1)}</td>
      <td className={`r num ${profitTone(r.avgSimReturnPct)}`}>{signedPct(r.avgSimReturnPct)}</td>
    </tr>
  );
}

/**
 * The same model over 24 hours and 7 days, from the leaderboard of each window (the shared cache
 * already holds the one on screen, and hovering the window switch prefetches the other).
 */
function WindowsTable({
  entry,
  api,
  days,
  targets: t,
}: {
  entry: LeaderboardEntry;
  api: string;
  days: number;
  targets: Leaderboard["targets"];
}) {
  const boards = [
    usePolling<Leaderboard>(`${api}/models?days=${WINDOWS[0]}`, 120_000),
    usePolling<Leaderboard>(`${api}/models?days=${WINDOWS[1]}`, 120_000),
  ];
  return (
    <div className="table-wrap">
      <table className="model-compare">
        <thead>
          <tr>
            <th>Window</th>
            <th className="r">Graded</th>
            <th className="r">2x</th>
            <th className="r">4x</th>
            <th className="r">10x</th>
            <th className="r">Avg profit</th>
            <th className="r">Rank</th>
          </tr>
        </thead>
        <tbody>
          {WINDOWS.map((w, i) => {
            const row = boards[i]!.data?.entries.find((x) => x.id === entry.id) ?? null;
            const r = row?.composite.live ?? null;
            return (
              <tr key={w} className={w === days ? "selected" : ""}>
                <td>{windowLong(w)}</td>
                {r ? (
                  <>
                    <td className="r num">{r.graded.toLocaleString()}</td>
                    <td
                      className={`r num ${rateTone(r.winRatePct, t.hitRate2xPct, r.graded)}`}
                      title={rateTitle(r.winRatePct, r.graded)}
                    >
                      {pct(r.winRatePct)}
                    </td>
                    <td className={`r num ${rateTone(r.goalRatePct, t.hitRate4xPct, r.graded)}`}>
                      {pct(r.goalRatePct)}
                    </td>
                    <td className="r num">{pct(r.tenXRatePct, 1)}</td>
                    <td className={`r num ${profitTone(r.avgSimReturnPct)}`}>
                      {signedPct(r.avgSimReturnPct)}
                    </td>
                    <td className="r num">#{row!.rank}</td>
                  </>
                ) : (
                  <td className="faint" colSpan={6}>
                    {boards[i]!.error ? "Couldn't load" : "Loading…"}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Its latest calls with how each did (signed-in readers; guests see the feed on a delay instead). */
function RecentCalls({ modelId, now }: { modelId: string; now: number }) {
  const page = usePolling<CuratedPage>(`/curated?model=${encodeURIComponent(modelId)}`, 60_000);
  const calls = page.data?.alerts.slice(0, RECENT_CALLS) ?? [];
  return (
    <>
      <h3>Latest calls</h3>
      {page.data === null ? (
        <p className="faint small">{page.error ? "Couldn't load its calls." : "Loading…"}</p>
      ) : calls.length === 0 ? (
        <p className="faint small">No calls yet.</p>
      ) : (
        <ul className="model-calls">
          {calls.map((c) => {
            const meta = c.curated;
            const outcome = meta ? outcomeAt(meta.outcome, meta.alertedAt, now) : null;
            const badge = outcomeBadge(outcome);
            const peak = meta?.peakPct ?? c.peakReturnPct;
            return (
              <li key={c.id}>
                <span className="model-call-token">
                  <strong>{tokenLabel(c.token)}</strong>
                  <small className="faint">
                    {ago(meta?.alertedAt ?? c.matchedAt, now)} at {usd(c.snapshot.marketCapUsd)}
                    {meta?.tier === "high" ? " · high conviction" : ""}
                  </small>
                </span>
                <span className="num model-call-peak" title="Highest it went above the call price">
                  {peak != null && peak > 0 ? `peak ${multiple(peak)}` : ""}
                </span>
                <span className={`badge ${badge.tone}`}>{badge.text}</span>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
