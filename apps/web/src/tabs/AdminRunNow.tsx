import { useState } from "react";
import { ApiError, post } from "../api";
import { usePolling } from "../hooks";
import { ago, shortAddress } from "../format";
import { Load, Panel, Table, Tag, ms, when } from "./adminShared";

/**
 * Admin > Worker > Run a job now: start a scheduled worker job early. A press queues a request the
 * worker that owns the job picks up within 30 seconds (routes/adminJobRuns.ts); only the jobs safe
 * to run off-schedule are listed, and the rest are named underneath with why.
 */

interface RunNowJob {
  job: string;
  does: string;
  heavy: boolean;
  role: string;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  durationMs: number | null;
  skipped: string | null;
  runningForMs: number | null;
  pending: { requestedAt: string; requestedBy: string | null } | null;
  lastRequest: { requestedAt: string; requestedBy: string | null; startedAt: string | null } | null;
}

interface RunNowState {
  jobs: RunNowJob[];
  excluded: { job: string; reason: string }[];
}

interface RunNowResult {
  queued: boolean;
  reason?: string;
}

export function RunNow() {
  const q = usePolling<RunNowState>("/admin/jobs/run-now", 15_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ job: string; text: string; tone: "ok" | "warn" } | null>(null);

  const runNow = async (j: RunNowJob) => {
    if (
      j.heavy &&
      !window.confirm(
        `Run ${j.job} now?\n\n${j.does}\n\nThis is a heavy job: it takes minutes of worker or database time, or spends on paid APIs.`,
      )
    )
      return;
    setBusy(j.job);
    setMessage(null);
    try {
      const res = await post<RunNowResult>(`/admin/jobs/${encodeURIComponent(j.job)}/run-now`, {
        confirm: j.heavy,
      });
      setMessage(
        res.queued
          ? { job: j.job, text: `${j.job} queued - the ${j.role} starts it within 30 seconds.`, tone: "ok" }
          : { job: j.job, text: `${j.job} not queued: ${res.reason ?? "refused"}.`, tone: "warn" },
      );
      q.reload();
    } catch (e) {
      setMessage({
        job: j.job,
        text: e instanceof ApiError || e instanceof Error ? e.message : String(e),
        tone: "warn",
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel
      title="Run a job now"
      note="Starts a scheduled job early, once. The worker that owns it picks the request up within 30 seconds; its next run then follows its usual cadence. Heavy jobs ask first."
    >
      <Load q={q}>
        {(d) => (
          <div className="stack">
            {message && (
              <p className="small" role="status">
                <Tag tone={message.tone}>{message.tone === "ok" ? "queued" : "not queued"}</Tag>{" "}
                {message.text}
              </p>
            )}
            <ul className="admin-run-list">
              {d.jobs.map((j) => (
                <li key={j.job} className="admin-run-row">
                  <div className="admin-run-what">
                    <span className="admin-run-job">
                      <b>{j.job}</b>
                      {j.heavy && <Tag tone="muted">heavy</Tag>}
                      <span className="faint small">{j.role}</span>
                    </span>
                    <span className="muted small">{j.does}</span>
                  </div>
                  <div className="admin-run-last small">
                    <span>
                      Last run {when(j.lastRunAt)}
                      {j.durationMs !== null && <span className="faint"> · took {ms(j.durationMs)}</span>}
                    </span>
                    {result(j)}
                  </div>
                  <div className="admin-run-action">
                    {j.pending ? (
                      <span
                        className="small muted"
                        title={`${new Date(j.pending.requestedAt).toLocaleString()}${j.pending.requestedBy ? ` by ${shortAddress(j.pending.requestedBy)}` : ""}`}
                      >
                        Queued
                        <br />
                        {ago(j.pending.requestedAt)}
                      </span>
                    ) : (
                      <button
                        className="ghost small"
                        disabled={busy !== null || j.runningForMs !== null || j.lastRunAt === null}
                        title={
                          j.lastRunAt === null
                            ? "This job has never run - no worker schedules it."
                            : j.runningForMs !== null
                              ? "A run is going now."
                              : undefined
                        }
                        onClick={() => void runNow(j)}
                      >
                        {busy === j.job ? "Queueing…" : "Run now"}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            <details className="small">
              <summary className="muted">Jobs that can't be run by hand ({d.excluded.length})</summary>
              <Table
                head={["Job", "Why not"]}
                rows={d.excluded.map((e) => [<b>{e.job}</b>, <span className="muted">{e.reason}</span>])}
              />
            </details>
          </div>
        )}
      </Load>
    </Panel>
  );
}

/** The last run's outcome: running, failed (with the error), skipped, or ok. */
function result(j: RunNowJob) {
  if (j.runningForMs !== null) return <Tag tone="ok">running {ms(j.runningForMs)}</Tag>;
  if (j.lastRunAt === null) return <Tag tone="muted">never run</Tag>;
  if (j.lastError)
    return (
      <span title={j.lastError}>
        <Tag tone={j.lastSuccessAt && j.lastSuccessAt >= j.lastRunAt ? "warn" : "bad"}>
          {j.lastSuccessAt && j.lastSuccessAt >= j.lastRunAt ? "partly failed" : "failed"}
        </Tag>{" "}
        <span className="admin-run-error">{j.lastError}</span>
      </span>
    );
  if (j.skipped) return <Tag tone="warn">{j.skipped}</Tag>;
  return <Tag tone="ok">ok</Tag>;
}
