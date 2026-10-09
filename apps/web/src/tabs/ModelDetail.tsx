import { useEffect, useRef, useState } from "react";
import type {
  CuratedPage,
  GradedRates,
  Leaderboard,
  LeaderboardEntry,
  ModelRun,
  ModelRunHistory,
  RecordSummary,
} from "../api";
import { runExamRates } from "../api";
import { CloseIcon } from "../components/Icons";
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
  doublings,
  profitTone,
  rateTone,
} from "./modelShared";

/** Latest calls the detail view lists. */
const RECENT_CALLS = 8;

/** Training runs listed before "Show all". */
const RUN_ROWS = 8;

/**
 * One model, everything about it, in a native modal dialog (a centered panel on desktop, a sheet
 * from the bottom on phones): its record over the picked window against the random-pick baseline,
 * the same record over every window, live against its backtest exam, its latest exam fold by fold,
 * its training runs and the recipes that held its seat before, and its latest calls.
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

  const liftOf = (rate: number | null | undefined, baseRate: number | null | undefined) =>
    rate == null || baseRate == null || baseRate <= 0 ? null : rate / baseRate;
  // Its own run history; the field-wide recent runs stand in until that loads.
  const history = usePolling<ModelRunHistory>(`${api}/models/${encodeURIComponent(e.id)}/runs`, 300_000);
  const myRuns = history.data?.runs ?? runs.filter((r) => r.contestant === e.id);
  const [allRuns, setAllRuns] = useState(false);
  const latestRun = myRuns[0] ?? null;
  const seat = board.evolution.history.filter((h) => h.slot === e.id);
  const basis = e.composite.basis ?? null;

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
        {e.isDefault && <span className="badge info">best performer</span>}
        {mine && <span className="badge">{guest ? "guest feed" : "in your feed"}</span>}
        {e.composite.warmingUp && <span className="badge">warming up</span>}
      </div>
      <p className="muted small">{e.summary ?? e.description}</p>

      <div className="model-detail-score">
        <ScoreBar score={e.composite.score} band={e.composite.band ?? null} title="Score, 0 to 100" />
        {e.scoreExplained && <p className="faint small">{e.scoreExplained}</p>}
      </div>

      <h3>Last {days} days, live</h3>
      <div className="model-figs">
        <RateFig
          label="Doubled (2x)"
          rate={live.winRatePct}
          goal={t.hitRate2xPct}
          lift={liftOf(live.winRatePct, base?.hitRate2xPct)}
          baseRate={base?.hitRate2xPct ?? null}
        />
        <RateFig
          label="Hit 4x"
          rate={live.goalRatePct}
          goal={t.hitRate4xPct}
          lift={liftOf(live.goalRatePct, base?.hitRate4xPct)}
          baseRate={base?.hitRate4xPct ?? null}
        />
        <RateFig
          label="Hit 10x"
          rate={live.tenXRatePct ?? null}
          goal={tenXGoal}
          lift={liftOf(live.tenXRatePct, base?.hitRate10xPct)}
          baseRate={base?.hitRate10xPct ?? null}
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
        . The small figure is lift: how many times a random pick&apos;s rate it hits.
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
            <RecordRow name={`Live, ${days}d`} r={live} t={t} />
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
            {latestRun.precisionCalibration?.support
              ? ` At its live cutoff it made ${latestRun.precisionCalibration.support} exam calls: ${pct(
                  latestRun.precisionCalibration.winRatePct,
                )} doubled, ${pct(latestRun.precisionCalibration.goalRatePct)} hit 4x.`
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
                        <td className={`r num ${rateTone(side.precisionPct, t.hitRate2xPct)}`}>
                          {pct(side.precisionPct)}
                        </td>
                        <td className={`r num ${rateTone(side.goalPrecisionPct, t.hitRate4xPct)}`}>
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
                    <td className="r num">{runExamRates(r).calls ?? "–"}</td>
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

/** A live rate as a tile: the rate, its lift over a random pick, and the goal. */
function RateFig({
  label,
  rate,
  goal,
  lift,
  baseRate,
  digits = 0,
}: {
  label: string;
  rate: number | null;
  goal: number;
  lift: number | null;
  baseRate: number | null;
  digits?: number;
}) {
  return (
    <div className="model-fig">
      <label>{label}</label>
      <span className={`num ${rateTone(rate, goal)}`}>{pct(rate, digits)}</span>
      <small className="faint">
        {lift !== null ? (
          <>
            <strong className={lift >= 1 ? "up" : "down"}>{lift.toFixed(1)}x</strong> random (
            {pct(baseRate, 1)})
          </>
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
      <td className={`r num ${rateTone(r.winRatePct, t.hitRate2xPct)}`}>{pct(r.winRatePct)}</td>
      <td className={`r num ${rateTone(r.goalRatePct, t.hitRate4xPct)}`}>{pct(r.goalRatePct)}</td>
      <td className="r num">{pct(r.tenXRatePct, 1)}</td>
      <td className={`r num ${profitTone(r.avgSimReturnPct)}`}>{signedPct(r.avgSimReturnPct)}</td>
    </tr>
  );
}

/**
 * The same model over 7, 30 and 90 days, from the leaderboard of each window (the shared cache
 * already holds the one on screen, and hovering the window switch prefetches the others).
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
    usePolling<Leaderboard>(`${api}/models?days=${WINDOWS[2]}`, 120_000),
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
                <td>{w} days</td>
                {r ? (
                  <>
                    <td className="r num">{r.graded.toLocaleString()}</td>
                    <td className={`r num ${rateTone(r.winRatePct, t.hitRate2xPct)}`}>{pct(r.winRatePct)}</td>
                    <td className={`r num ${rateTone(r.goalRatePct, t.hitRate4xPct)}`}>
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
