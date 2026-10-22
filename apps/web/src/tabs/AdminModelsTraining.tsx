import { useState } from "react";
import type { Leaderboard, LeaderboardEntry, LearningCurve } from "../api";
import type { Loadable } from "../hooks";
import { pct, signedPct } from "../format";
import { AdminBars, AdminLines } from "../components/AdminChart";
import { Load, Panel, Tag, dollars, n } from "./adminShared";
import { formatAdminDay, formatAdminTime, formatDuration } from "./adminTime";
import {
  compareRows,
  examSeries,
  feedRateSeries,
  hasNumber,
  modelRateSeries,
  readExam,
  stageBars,
  trainingProgress,
  type CompareRow,
  type ExamView,
  type ExplainSeatRef,
  type RosterSeat,
} from "./adminModelsView";

/** GET /admin/models/desk. Dates arrive as ISO strings. */
export interface ModelsDesk {
  stages: string[];
  caps: {
    windowDays: number;
    maxRows: number;
    minRowsToPromote: number;
    intervalHours: number;
    excludeFineTick: boolean;
    legacyLabelWeight: number;
  };
  labels: { fitRule: number; fineTickRule: number; reportedRule: number; summary: string };
  schedule: {
    intervalMs: number | null;
    intervalSource: "heartbeat" | "configured";
    lastRunAt: string | null;
    lastSuccessAt: string | null;
    lastError: string | null;
    durationMs: number | null;
    stagesMs: Record<string, number> | null;
    heldBack: string | null;
    alarms: string | null;
    stored: boolean | null;
    runningForMs: number | null;
    runningSince: string | null;
    runningStep: { step: string; since: string | null } | null;
    runningStagesMs: Record<string, number> | null;
    hung: boolean;
    orphaned: boolean;
    progressAt: string | null;
    rowUpdatedAt: string | null;
    nextRunAt: string | null;
    nextRunBasis: string;
    pending: { requestedAt: string; requestedBy: string | null } | null;
  };
  aiBudget: {
    day: string;
    capUsd: number;
    spentUsd: number;
    remainingUsd: number;
    reservePct: number;
    stopped: boolean;
    backgroundPaused: boolean;
    resetsAt: string;
    bySource: { source: string; costUsd: number; calls: number; refused: number }[];
  };
  roster: RosterSeat[];
  active: {
    id: string;
    contestant: string | null;
    kind: string;
    status: string;
    trainingRows: number;
    trainingFrom: string;
    trainingTo: string;
    createdAt: string;
    activatedAt: string | null;
    exam: ExamView | null;
  }[];
  runHistoryNote: string;
}

const rate = (part: number, whole: number) => (whole > 0 ? pct((part / whole) * 100, 1) : "–");

function span(from: string | null | undefined, to: string | null | undefined) {
  const a = formatAdminDay(from);
  const b = formatAdminDay(to);
  if (!a || !b) return "–";
  return `${a} to ${b}`;
}

export function ModelsStatus({ q }: { q: Loadable<ModelsDesk> }) {
  return (
    <Load q={q}>
      {(d) => {
        const s = d.schedule;
        const running = s.runningForMs != null;
        const stages = running ? s.runningStagesMs : s.stagesMs;
        const order = d.stages ?? [];
        const progress = trainingProgress(
          order,
          running ? s.runningStagesMs : null,
          s.runningStep?.step ?? null,
        );
        const state = s.orphaned ? (
          <Tag tone="bad">run lost</Tag>
        ) : s.hung ? (
          <Tag tone="bad">looks stuck</Tag>
        ) : running ? (
          <Tag tone="ok">training</Tag>
        ) : s.pending ? (
          <Tag tone="warn">queued</Tag>
        ) : s.lastError ? (
          <Tag tone="bad">last run failed</Tag>
        ) : s.lastRunAt ? (
          <Tag tone="ok">idle</Tag>
        ) : (
          <Tag tone="muted">no heartbeat</Tag>
        );
        return (
          <div className="stack">
            <section className="admin-rail" aria-label="Trainer">
              <div>
                <dt>Trainer</dt>
                <dd>
                  {state}{" "}
                  {running
                    ? formatDuration(s.runningForMs)
                    : s.pending
                      ? "waiting for the trainer"
                      : "not running"}
                  {s.stored === false && !running ? " · did not store" : ""}
                </dd>
              </div>
              <div>
                <dt>Phase</dt>
                <dd>{running ? (s.runningStep?.step ?? "started, no step stamped yet") : "–"}</dd>
              </div>
              <div>
                <dt>Started</dt>
                <dd>{running ? (formatAdminTime(s.runningSince) ?? "–") : "–"}</dd>
              </div>
              <div>
                <dt>Last progress</dt>
                <dd>
                  {running
                    ? (formatAdminTime(s.progressAt) ?? "no progress stamp yet")
                    : (formatAdminTime(s.rowUpdatedAt) ?? "–")}
                </dd>
              </div>
              <div>
                <dt>Next run</dt>
                <dd>{formatAdminTime(s.nextRunAt) ?? "not known"}</dd>
              </div>
              <div>
                <dt>Last finished</dt>
                <dd>
                  {formatAdminTime(s.lastSuccessAt) ?? "never"}
                  {s.durationMs != null ? ` · ${formatDuration(s.durationMs)}` : ""}
                </dd>
              </div>
            </section>
            <p className="muted small">{s.nextRunBasis}</p>
            {running && (
              <div className="admin-progress-row">
                <div className="admin-progress" aria-label="Training progress">
                  <span
                    className="admin-progress-fill"
                    style={{
                      width: `${progress.total > 0 ? (progress.doneCount / progress.total) * 100 : 0}%`,
                    }}
                  />
                </div>
                <span className="admin-progress-label">
                  {progress.doneCount} of {progress.total} stages finished
                  {progress.current ? ` · now ${progress.current}` : ""}
                </span>
              </div>
            )}
            {(s.lastError || s.heldBack || s.alarms) && (
              <p className="small">
                {s.lastError && (
                  <>
                    <Tag tone="bad">error</Tag> <span className="admin-error">{s.lastError}</span>{" "}
                  </>
                )}
                {s.heldBack && (
                  <>
                    <Tag tone="warn">held back</Tag> {s.heldBack}{" "}
                  </>
                )}
                {s.alarms && (
                  <>
                    <Tag tone="warn">alarms</Tag> {s.alarms}
                  </>
                )}
              </p>
            )}
            <div className="admin-split">
              <Panel
                title={running ? "Stages finished this run" : "Last finished run"}
                note={
                  stages
                    ? "Minutes per stage the trainer recorded. The step under way has no duration yet."
                    : undefined
                }
              >
                <AdminBars
                  label={running ? "Stages finished this run, in minutes" : "Last run stages, in minutes"}
                  rows={stageBars(stages, order)}
                  formatValue={(v) => `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}m`}
                  empty={
                    running
                      ? "No stage has finished yet. The phase line above is the step in flight."
                      : "No stage times on the last heartbeat."
                  }
                />
              </Panel>
              <Panel
                title="Trainer spec"
                note="Configured limits. A model's own window is on its row, below."
              >
                <dl className="admin-spec">
                  <div>
                    <dt>Interval</dt>
                    <dd>
                      {formatDuration(s.intervalMs)} <span className="faint">({s.intervalSource})</span>
                    </dd>
                  </div>
                  <div>
                    <dt>Window cap</dt>
                    <dd>{n(d.caps.windowDays)} days</dd>
                  </div>
                  <div>
                    <dt>Row cap</dt>
                    <dd>{n(d.caps.maxRows)}</dd>
                  </div>
                  <div>
                    <dt>Rows to promote</dt>
                    <dd>{n(d.caps.minRowsToPromote)}</dd>
                  </div>
                  <div>
                    <dt>Legacy weight</dt>
                    <dd>{d.caps.legacyLabelWeight}</dd>
                  </div>
                  <div>
                    <dt>AI budget</dt>
                    <dd>
                      {dollars(d.aiBudget.spentUsd)} / {dollars(d.aiBudget.capUsd)}{" "}
                      {d.aiBudget.stopped ? (
                        <Tag tone="bad">stopped</Tag>
                      ) : d.aiBudget.backgroundPaused ? (
                        <Tag tone="warn">background paused</Tag>
                      ) : (
                        <Tag tone="ok">open</Tag>
                      )}
                    </dd>
                  </div>
                </dl>
                <p className="muted small">{d.labels.summary}</p>
                <p className="faint small">
                  AI day {d.aiBudget.day} UTC · resets {formatAdminTime(d.aiBudget.resetsAt) ?? "–"} · reserve{" "}
                  {n(d.aiBudget.reservePct)}% for live reviews.
                  {d.aiBudget.bySource.length === 0
                    ? " No spend recorded today."
                    : ` ${d.aiBudget.bySource.map((b) => `${b.source} ${dollars(b.costUsd)}`).join(" · ")}.`}
                </p>
              </Panel>
            </div>
          </div>
        );
      }}
    </Load>
  );
}

type Measure = "score" | "hit" | "return";

export function ModelsCompare({
  roster,
  explain,
  board,
  selected,
  onPick,
}: {
  roster: readonly RosterSeat[];
  explain: readonly ExplainSeatRef[];
  board: Loadable<Leaderboard>;
  selected: string | null;
  onPick: (id: string) => void;
}) {
  const [measure, setMeasure] = useState<Measure>("score");
  const rows = compareRows(roster, explain, board.data?.entries ?? null);
  const ordered = [...rows].sort(
    (a, b) =>
      Number(b.enabled && !b.retired) - Number(a.enabled && !a.retired) || a.name.localeCompare(b.name),
  );
  const value = (r: CompareRow): number | null =>
    measure === "score" ? r.score : measure === "hit" ? r.hit2x : r.avgReturnPct;
  const chartRows = ordered
    .filter((r) => r.enabled && !r.retired)
    .map((r) => ({ label: r.name, value: value(r) }));
  const windowDays = board.data?.window.days;
  return (
    <Panel
      title="Comparison"
      note={
        board.data
          ? `Composite score, live hit rate and exit-plan return over ${windowDays} days. 24h columns are the dropdown window. A blank is a field the board did not have.`
          : "Scores load from the leaderboard. The roster is the configured contest, including seats that are off."
      }
      actions={
        <div className="segmented small" role="tablist" aria-label="Comparison measure">
          {(
            [
              ["score", "Score"],
              ["hit", "2x rate"],
              ["return", "Return"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={measure === id}
              className={measure === id ? "on" : ""}
              onClick={() => setMeasure(id)}
            >
              {label}
            </button>
          ))}
        </div>
      }
    >
      <div className="stack">
        {board.error && !board.data && (
          <p className="error small">Leaderboard didn't load: {board.error.message}. Scores stay blank.</p>
        )}
        {board.loading && !board.data && <p className="muted small">Loading the leaderboard…</p>}
        <AdminBars
          label={
            measure === "score"
              ? "Composite score by model"
              : measure === "hit"
                ? "Live 2x rate by model, percent"
                : "Average return by model, percent"
          }
          rows={chartRows}
          formatValue={
            measure === "score"
              ? (v) => v.toFixed(1)
              : measure === "hit"
                ? (v) => pct(v, 1)
                : (v) => signedPct(v, 1)
          }
          empty={
            roster.length === 0
              ? "Roster not loaded yet."
              : measure === "score"
                ? "No composite scores in this window."
                : measure === "hit"
                  ? "No graded live calls in this window."
                  : "No simulated returns in this window."
          }
        />
        {ordered.length > 0 && (
          <div className="table-wrap">
            <table className="model-lineup">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Enabled</th>
                  <th>Status</th>
                  <th className="r">Score</th>
                  <th className="r">Graded</th>
                  <th className="r">2x</th>
                  <th className="r">4x</th>
                  <th className="r">Return</th>
                  <th className="r">Peak</th>
                  <th className="r">24h 2x</th>
                  <th className="r">Alerts / h</th>
                </tr>
              </thead>
              <tbody>
                {ordered.map((r) => (
                  <tr
                    key={r.id}
                    className={r.id === selected ? "selected" : ""}
                    onClick={() => onPick(r.id)}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onPick(r.id);
                      }
                    }}
                    aria-selected={r.id === selected}
                  >
                    <td>
                      <span className="model-name">{r.name}</span>
                      <span className="faint small">{r.role}</span>
                    </td>
                    <td>
                      {r.retired ? (
                        <Tag tone="muted">retired</Tag>
                      ) : r.enabled ? (
                        <Tag tone="ok">on</Tag>
                      ) : (
                        <Tag tone="warn">off</Tag>
                      )}
                    </td>
                    <td>
                      {r.status ? <Tag tone={r.status === "calling" ? "ok" : "muted"}>{r.status}</Tag> : "–"}
                    </td>
                    <td className="r num">{r.score === null ? "–" : r.score.toFixed(1)}</td>
                    <td className="r num">{r.graded === null ? "–" : n(r.graded)}</td>
                    <td className="r num">{pct(r.hit2x, 1)}</td>
                    <td className="r num">{pct(r.hit4x, 1)}</td>
                    <td className="r num">{r.avgReturnPct === null ? "–" : signedPct(r.avgReturnPct)}</td>
                    <td className="r num" title="Average doublings to the run peak, when the board stores it">
                      {r.avgDoublings === null ? "–" : r.avgDoublings.toFixed(2)}
                    </td>
                    <td className="r num">
                      {r.last24hHit === null ? "–" : pct(r.last24hHit, 0)}
                      {r.last24hGraded != null ? (
                        <span className="faint"> ({n(r.last24hGraded)})</span>
                      ) : null}
                    </td>
                    <td className="r num">{r.callsPerHour === null ? "–" : r.callsPerHour.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {ordered.length === 0 && <p className="muted small">No roster yet.</p>}
      </div>
    </Panel>
  );
}

export function ModelsPerformance({
  q,
  modelId,
  modelName,
}: {
  q: Loadable<LearningCurve>;
  modelId: string | null;
  modelName: string | null;
}) {
  return (
    <Load q={q}>
      {(curve) => {
        const feed = feedRateSeries(curve.days);
        const own = modelRateSeries(curve, modelId);
        const exams = examSeries(curve.runs, modelId);
        const zone = curve.timeZone || "UTC";
        return (
          <div className="admin-split">
            <Panel
              title="Calls over time"
              note={`2x rate by day in ${zone}. Feed is every model pooled. Market is the decision moments. A gap is a day under the lift floor, not a zero.`}
            >
              <AdminLines
                label="Feed and market 2x rate by day"
                points={feed}
                names={["Feed 2x %", "Market 2x %"]}
                empty="No graded days in this window."
              />
            </Panel>
            <Panel
              title={modelName ? `${modelName} over time` : "Selected model over time"}
              note="Its own calls, then the exam of each stored run that included it. Score and rate stay on separate charts."
            >
              <h3>Live 2x</h3>
              <AdminLines
                label={`${modelName ?? "Model"} 2x rate by day`}
                points={own.map((p) => ({ label: p.label, values: [p.values[0] ?? null] }))}
                names={["2x %"]}
                empty={modelId ? "No graded calls for this model in the window." : "Pick a model."}
              />
              {hasNumber(own.map((p) => p.values[1] ?? null)) && (
                <>
                  <h3>Live return</h3>
                  <AdminLines
                    label={`${modelName ?? "Model"} average return by day`}
                    points={own.map((p) => ({ label: p.label, values: [p.values[1] ?? null] }))}
                    names={["Avg return %"]}
                    empty="No simulated returns."
                  />
                </>
              )}
              <h3>Exam score by run</h3>
              <AdminLines
                label={`${modelName ?? "Model"} exam score by run`}
                points={exams.map((p) => ({ label: p.label, values: [p.values[0] ?? null] }))}
                names={["Exam score"]}
                empty="No stored exam score for this model in the window."
              />
              <h3>Exam 2x by run</h3>
              <AdminLines
                label={`${modelName ?? "Model"} exam 2x rate by run`}
                points={exams.map((p) => ({ label: p.label, values: [p.values[1] ?? null] }))}
                names={["Exam 2x %"]}
                empty="No stored exam 2x rate for this model in the window."
              />
            </Panel>
          </div>
        );
      }}
    </Load>
  );
}

export function ModelRecord({
  name,
  enabled,
  retired,
  status,
  kind,
  modelId,
  trainedAt,
  trainingRows,
  trainingFrom,
  trainingTo,
  exam,
  entry,
  labelSummary,
}: {
  name: string;
  enabled: boolean;
  retired: boolean;
  status: string | null;
  kind: string | null;
  modelId: string | null;
  trainedAt: string | null;
  trainingRows: number | null;
  trainingFrom: string | null;
  trainingTo: string | null;
  exam: ExamView | null;
  entry: LeaderboardEntry | null;
  labelSummary: string | null;
}) {
  const live = entry?.composite.live;
  return (
    <div className="stack" id="models-seat">
      <dl className="admin-spec">
        <div>
          <dt>Seat</dt>
          <dd>
            {name}{" "}
            {retired ? (
              <Tag tone="muted">retired</Tag>
            ) : enabled ? (
              <Tag tone="ok">enabled</Tag>
            ) : (
              <Tag tone="warn">disabled</Tag>
            )}
            {status && <Tag tone={status === "calling" ? "ok" : "muted"}>{status}</Tag>}
          </dd>
        </div>
        <div>
          <dt>Version</dt>
          <dd>{kind ?? "no model row"}</dd>
        </div>
        <div>
          <dt>Model id</dt>
          <dd className="break-any">{modelId ?? "–"}</dd>
        </div>
        <div>
          <dt>Trained</dt>
          <dd>{formatAdminTime(trainedAt) ?? "–"}</dd>
        </div>
        <div>
          <dt>Rows</dt>
          <dd>{trainingRows === null ? "–" : n(trainingRows)}</dd>
        </div>
        <div>
          <dt>Window it saw</dt>
          <dd>{span(trainingFrom, trainingTo)}</dd>
        </div>
        <div>
          <dt>Score</dt>
          <dd>{entry?.composite.score == null ? "–" : entry.composite.score.toFixed(1)}</dd>
        </div>
        <div>
          <dt>Live 2x / 4x</dt>
          <dd>
            {pct(live?.winRatePct, 1)} / {pct(live?.goalRatePct, 1)}
            {live ? <span className="faint"> ({n(live.graded)} graded)</span> : null}
          </dd>
        </div>
        <div>
          <dt>Return / peak</dt>
          <dd>
            {live?.avgSimReturnPct == null ? "–" : signedPct(live.avgSimReturnPct)}
            {" / "}
            {live?.avgReturnDoublings == null ? "–" : `${live.avgReturnDoublings.toFixed(2)} doublings`}
          </dd>
        </div>
      </dl>
      {exam && (
        <p className="small muted">
          Stored exam: {rate(exam.wins, exam.graded)} 2x · {rate(exam.goals, exam.graded)} 4x
          {exam.tenX === null ? "" : ` · ${rate(exam.tenX, exam.graded)} 10x`} on {n(exam.graded)} graded of{" "}
          {n(exam.calls)}.
          {exam.avgReturnPct === null
            ? " Return not stored on this exam."
            : ` Avg return ${signedPct(exam.avgReturnPct)}.`}
          {exam.avgRunDoublings === null
            ? " Run peak not stored on this exam."
            : ` Avg run peak ${exam.avgRunDoublings.toFixed(2)} doublings.`}
        </p>
      )}
      {!enabled && !retired && (
        <p className="small">
          This seat is not in CURATOR_CONTESTANTS, so the trainer does not fit it and it does not call.
        </p>
      )}
      {labelSummary && <p className="faint small">{labelSummary}</p>}
    </div>
  );
}

/** Run-history cells shared with the training table. Null exams stay dashes. */
export function examCells(raw: unknown) {
  const exam = readExam(raw);
  if (!exam) return ["–", "–", "–"] as const;
  return [
    <span className="num">
      {rate(exam.wins, exam.graded)} / {rate(exam.goals, exam.graded)}
      {exam.tenX === null ? "" : ` / ${rate(exam.tenX, exam.graded)}`}
    </span>,
    exam.avgReturnPct === null ? "–" : signedPct(exam.avgReturnPct),
    exam.avgRunDoublings === null
      ? exam.avgDoublings === null
        ? "–"
        : exam.avgDoublings.toFixed(2)
      : exam.avgRunDoublings.toFixed(2),
  ] as const;
}
