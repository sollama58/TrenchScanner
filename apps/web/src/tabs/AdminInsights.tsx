import { useState, type ReactNode } from "react";
import { narrativeCriteriaLines } from "../filterFields";
import { post, type FilterCriteria } from "../api";
import { usePolling } from "../hooks";
import { ago, pct, shortAddress, usd } from "../format";
import { Kpi, Load, Panel, Table, Tag, Wallet, n, when } from "./adminShared";

/**
 * The Admin sections added after the first panel: training history, TokenSage, the safety
 * screen, every saved filter, and outside lookups. Each reads one /admin route (see
 * apps/api/src/routes/adminInsights.ts) and loads only while its section is open.
 */

/** A row of window buttons ("1d 7d", "1h 3h 6h"). */
function WindowPicker<T extends number>({
  options,
  value,
  onChange,
  unit,
}: {
  options: T[];
  value: T;
  onChange: (v: T) => void;
  unit: string;
}) {
  return (
    <div className="segmented" role="tablist" aria-label="Window">
      {options.map((o) => (
        <button
          key={o}
          role="tab"
          aria-selected={o === value}
          className={o === value ? "on" : ""}
          onClick={() => onChange(o)}
        >
          {o}
          {unit}
        </button>
      ))}
    </div>
  );
}

const share = (part: number, whole: number) => (whole > 0 ? pct((part / whole) * 100, 0) : "–");
const rate = (part: number, whole: number) => (whole > 0 ? pct((part / whole) * 100, 1) : "–");
const token = (mint: string, symbol: string | null) => (
  <a href={`https://dexscreener.com/solana/${mint}`} target="_blank" rel="noreferrer" title={mint}>
    {symbol ?? shortAddress(mint)}
  </a>
);

interface Count {
  label: string;
  count: number;
}

/** A small "label, count, share" table. */
function Counts({ title, rows, empty }: { title: string; rows: Count[]; empty?: string }) {
  const total = rows.reduce((s, r) => s + r.count, 0);
  return (
    <div>
      <h3>{title}</h3>
      <Table
        head={["", "Count", "Share"]}
        rows={rows.map((r) => [r.label, <span className="num">{n(r.count)}</span>, share(r.count, total)])}
        empty={empty ?? "Nothing in this window."}
      />
    </div>
  );
}

// ---------- Training ----------

interface HeartbeatJob {
  job: string;
  lastRunAt: string;
  lastSuccessAt: string | null;
  lastError: string | null;
  stale: boolean;
  hung: boolean;
  runningForMs: number | null;
  lastRun: { durationMs?: number } | null;
}
interface CallRecord {
  calls: number;
  graded: number;
  wins: number;
  goals: number;
  tenX?: number;
}
interface TrainingRun {
  id: string;
  createdAt: string;
  contestant: string | null;
  name: string | null;
  kind: string;
  learner: string | null;
  status: string;
  trainingRows: number;
  trainingFrom: string;
  trainingTo: string;
  activatedAt: string | null;
  retiredAt: string | null;
  verdict: { promote?: boolean; reason?: string } | null;
  exam: CallRecord | null;
  calibration: {
    support?: number;
    winRatePct?: number | null;
    goalRatePct?: number | null;
    meetsTargets?: boolean;
  } | null;
  highConvictionEarned: boolean | null;
  heldFeatures: number | null;
}
interface TrainingReport {
  jobs: HeartbeatJob[];
  runs: TrainingRun[];
  champions: {
    id: string;
    contestant: string;
    name: string;
    score: number | null;
    liveGraded: number;
    previous: string | null;
    reason: string;
    chosenAt: string;
  }[];
  probations: {
    id: string;
    slot: string;
    name: string;
    laneName: string;
    generation: number;
    parentName: string | null;
    examScore: number | null;
    reason: string;
    startedAt: string;
    resolvedAt: string | null;
    outcome: string | null;
    resolvedReason: string | null;
  }[];
  lanes: {
    id: string;
    slot: string;
    name: string;
    description: string;
    generation: number;
    parentName: string | null;
    examScore: number | null;
    bornAt: string;
    retiredAt: string | null;
    retiredReason: string | null;
  }[];
  scoreWeights: {
    id: string;
    createdAt: string;
    momentum: number;
    freshness: number;
    holderQuality: number;
    narrative: number;
    adopted: boolean;
    reason: string;
    metrics: {
      holdoutCurrent?: number | null;
      holdoutProposed?: number | null;
      rows?: { event: number; match: number; eventWins: number; matchWins: number };
    } | null;
  }[];
}

const longText = (s: string | null | undefined) =>
  s ? <span className="admin-note">{s}</span> : <span className="faint">–</span>;
const weight = (v: number) => pct(v * 100, 0);

interface RetrainState {
  pending: { requestedAt: string; requestedBy: string | null } | null;
  last: { requestedAt: string; requestedBy: string | null; startedAt: string | null } | null;
  job: {
    lastRunAt: string;
    lastSuccessAt: string | null;
    lastError: string | null;
    runningForMs: number | null;
    durationMs: number | null;
  } | null;
}

/**
 * "Retrain now": queues a training run the trainer worker starts within a minute, instead of
 * waiting for its next slot. One at a time; the cadence restarts from the forced run.
 */
function RetrainNow() {
  const q = usePolling<RetrainState>("/admin/curator/retrain", 15_000);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const s = q.data;
  const running = s?.job?.runningForMs != null;
  const queue = async () => {
    if (!window.confirm("Retrain every model now? It runs on the trainer and takes a while.")) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await post<RetrainState & { queued: boolean; reason?: string }>("/admin/curator/retrain", {});
      setResult(r.queued ? "Queued. The trainer starts it within a minute." : `Not queued: ${r.reason}.`);
      q.reload();
    } catch (e) {
      setResult(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };
  const state = running
    ? `Training now, started ${Math.round((s!.job!.runningForMs ?? 0) / 60_000)}m ago.`
    : s?.pending
      ? `Queued ${ago(s.pending.requestedAt)}, waiting for the trainer to pick it up.`
      : s?.job
        ? `Last run ${ago(s.job.lastRunAt)}${s.job.durationMs ? `, took ${Math.round(s.job.durationMs / 60_000)}m` : ""}${s.job.lastError ? ", failed" : ""}.`
        : "No training run recorded yet.";
  return (
    <Panel
      title="Retrain models"
      note="Training runs on a fixed schedule. Retrain now starts a run on the trainer within a minute and the schedule restarts from it."
      actions={
        <button
          className="button primary"
          disabled={busy || running || !!s?.pending}
          onClick={() => void queue()}
        >
          {running ? "Training…" : s?.pending ? "Queued" : "Retrain now"}
        </button>
      }
    >
      <p className="small">{state}</p>
      {result && <p className="small faint">{result}</p>}
    </Panel>
  );
}

export function Training() {
  const q = usePolling<TrainingReport>("/admin/training", 60_000);
  return (
    <Load q={q}>
      {(t) => (
        <div className="stack">
          <RetrainNow />
          <Panel title="Trainer jobs" note="The trainer worker's scheduled jobs, from their heartbeats.">
            <Table
              head={["Job", "State", "Last run", "Last success", "Error"]}
              rows={t.jobs.map((j) => [
                <b>{j.job}</b>,
                j.hung ? (
                  <Tag tone="bad">hung</Tag>
                ) : j.runningForMs !== null ? (
                  <Tag tone="ok">running</Tag>
                ) : j.stale ? (
                  <Tag tone="warn">stale</Tag>
                ) : j.lastError ? (
                  <Tag tone="warn">failed</Tag>
                ) : (
                  <Tag tone="ok">ok</Tag>
                ),
                when(j.lastRunAt),
                when(j.lastSuccessAt),
                j.lastError ? (
                  <span className="admin-error">{j.lastError}</span>
                ) : (
                  <span className="faint">–</span>
                ),
              ])}
              empty="No trainer heartbeats yet."
            />
          </Panel>
          <Panel
            title="Training runs"
            note="The newest 60 trained models, every seat. Exam = the walk-forward test on held-out rows; cutoff = the record at the hit-rate cutoff it ships with."
          >
            <Table
              head={[
                "When",
                "Seat",
                "Learner",
                "Status",
                "Rows",
                "Data",
                "Exam 2x / 4x",
                "Cutoff 2x / 4x",
                "High tier",
                "Held inputs",
                "Verdict",
              ]}
              rows={t.runs.map((r) => [
                when(r.createdAt),
                <span title={r.contestant ?? undefined}>{r.name ?? r.contestant ?? "–"}</span>,
                r.learner ?? r.kind,
                <Tag tone={r.status === "active" ? "ok" : "muted"}>{r.status}</Tag>,
                <span className="num">{n(r.trainingRows)}</span>,
                <span className="small">
                  {new Date(r.trainingFrom).toLocaleDateString()} to{" "}
                  {new Date(r.trainingTo).toLocaleDateString()}
                </span>,
                r.exam ? (
                  <span className="num" title={`${r.exam.graded} graded of ${r.exam.calls} calls`}>
                    {rate(r.exam.wins, r.exam.graded)} / {rate(r.exam.goals, r.exam.graded)}{" "}
                    <span className="faint">({n(r.exam.graded)})</span>
                  </span>
                ) : (
                  "–"
                ),
                r.calibration ? (
                  <span className="num" title={`${r.calibration.support ?? 0} calls at the cutoff`}>
                    {pct(r.calibration.winRatePct, 1)} / {pct(r.calibration.goalRatePct, 1)}{" "}
                    {r.calibration.meetsTargets ? <Tag tone="ok">meets</Tag> : null}
                  </span>
                ) : (
                  "–"
                ),
                r.highConvictionEarned === null ? (
                  "–"
                ) : r.highConvictionEarned ? (
                  <Tag tone="ok">earned</Tag>
                ) : (
                  <Tag tone="muted">not earned</Tag>
                ),
                r.heldFeatures === null ? "–" : n(r.heldFeatures),
                longText(r.verdict?.reason),
              ])}
              empty="No training runs yet."
            />
          </Panel>
          <Panel
            title="Default model history"
            note="Each time the leaderboard's pick for the default model changed."
          >
            <Table
              head={["When", "Model", "Score", "Live graded", "Replaced", "Why"]}
              rows={t.champions.map((c) => [
                when(c.chosenAt),
                <b title={c.contestant}>{c.name}</b>,
                c.score === null ? "–" : c.score.toFixed(1),
                n(c.liveGraded),
                c.previous ?? "–",
                longText(c.reason),
              ])}
              empty="No default chosen yet."
            />
          </Panel>
          <Panel
            title="Probation"
            note="Challengers that won a seat on the exam and had to win again on fresh calls."
          >
            <Table
              head={["Started", "Challenger", "Against", "Gen", "Exam score", "Outcome", "Resolved", "Why"]}
              rows={t.probations.map((p) => [
                when(p.startedAt),
                <b title={p.parentName ? `bred from ${p.parentName}` : undefined}>{p.name}</b>,
                p.laneName,
                n(p.generation),
                p.examScore === null ? "–" : p.examScore.toFixed(1),
                p.outcome ? (
                  <Tag tone={p.outcome === "confirmed" ? "ok" : "muted"}>{p.outcome}</Tag>
                ) : (
                  <Tag tone="warn">pending</Tag>
                ),
                when(p.resolvedAt),
                longText(p.resolvedReason ?? p.reason),
              ])}
              empty="No challenger has been on probation yet."
            />
          </Panel>
          <Panel
            title="Seat history"
            note="Recipes that took a learner seat, newest first, and why the replaced ones lost it."
          >
            <Table
              head={[
                "Seated",
                "Seat",
                "Name",
                "Gen",
                "Parent",
                "Exam score",
                "State",
                "Why it lost the seat",
              ]}
              rows={t.lanes.map((l) => [
                when(l.bornAt),
                l.slot,
                <b title={l.description}>{l.name}</b>,
                n(l.generation),
                l.parentName ?? "–",
                l.examScore === null ? "–" : l.examScore.toFixed(1),
                l.retiredAt ? (
                  <Tag tone="muted">replaced {when(l.retiredAt)}</Tag>
                ) : (
                  <Tag tone="ok">holding</Tag>
                ),
                longText(l.retiredReason),
              ])}
              empty="No seat history yet."
            />
          </Panel>
          <Panel
            title="Score weight fits"
            note="Each refit of the token score's four parts. Adopted sets are what every process scores with; the rest are kept as the record."
          >
            <Table
              head={[
                "When",
                "Result",
                "Momentum",
                "Freshness",
                "Holders",
                "Narrative",
                "Rank quality",
                "Rows (wins)",
                "Why",
              ]}
              rows={t.scoreWeights.map((w) => [
                when(w.createdAt),
                w.adopted ? <Tag tone="ok">adopted</Tag> : <Tag tone="muted">kept old</Tag>,
                weight(w.momentum),
                weight(w.freshness),
                weight(w.holderQuality),
                weight(w.narrative),
                w.metrics?.holdoutCurrent != null && w.metrics.holdoutProposed != null
                  ? `${w.metrics.holdoutCurrent.toFixed(3)} to ${w.metrics.holdoutProposed.toFixed(3)}`
                  : "–",
                w.metrics?.rows
                  ? `${n(w.metrics.rows.event + w.metrics.rows.match)} (${n(w.metrics.rows.eventWins + w.metrics.rows.matchWins)})`
                  : "–",
                longText(w.reason),
              ])}
              empty="No weight fits yet."
            />
          </Panel>
        </div>
      )}
    </Load>
  );
}

// ---------- TokenSage ----------

interface Tally {
  label: string;
  alerts: number;
  graded: number;
  won2x: number;
  won4x: number;
  won10x: number;
}
interface TokenSageReport {
  window: { days: number; since: string };
  status: {
    on: boolean;
    lastCycleAt: string | null;
    lastCycle: Record<string, number> | null;
    scanSeenAt: string | null;
  };
  stored: {
    allTime: number;
    inWindow: number;
    byDepthStatus: { depth: string; status: string; count: number }[];
    newestAt: string | null;
    avgReferentConfidence: number | null;
    avgXFit: number | null;
    medianStoreLagSeconds: number | null;
  };
  failReasons: Count[];
  categories: Count[];
  topLevelCategories: Count[];
  referentKinds: Count[];
  referentSupport: Count[];
  flags: Count[];
  xVerdicts: Count[];
  pairKinds: Count[];
  rulesVersions: Count[];
  copies: Count[];
  trend?: Count[];
  trendSources?: Count[];
  outcomes: {
    alerts: number;
    capped: boolean;
    byCoverage: Tally[];
    byCategory: Tally[];
    byXVerdict: Tally[];
    byCopy: Tally[];
    byFlag: Tally[];
  };
}
interface Narrative {
  mintAddress: string;
  depth: string;
  status: string;
  categories: { label: string; confidence: number }[] | null;
  referentLabel: string | null;
  referentKind: string | null;
  referentConfidence: number | null;
  referentSupport: string[];
  referentGeneric?: boolean | null;
  summary: string | null;
  flags: string[];
  xFit: number | null;
  xVerdict: string | null;
  pairKind: string | null;
  pairSymbol: string | null;
  copiesRecent: boolean | null;
  failReason: string | null;
  rulesVersion: string | null;
  analyzedAt: string | null;
  checkedAt: string;
  symbol: string | null;
  name: string | null;
}

const tallyHead = ["Alerts", "Graded", "2x", "4x", "10x"];
const tallyCells = (t: Tally) => [
  <span className="num">{n(t.alerts)}</span>,
  <span className="num">{n(t.graded)}</span>,
  <span className="num">{rate(t.won2x, t.graded)}</span>,
  <span className="num">{rate(t.won4x, t.graded)}</span>,
  <span className="num">{rate(t.won10x, t.graded)}</span>,
];

const LAST_CYCLE_LABELS: Record<string, string> = {
  requested: "asked",
  stored: "stored",
  failed: "failed",
  pending: "waiting on TokenSage",
  waiting: "queued to ask",
  errors: "errors",
  turnedAway: "turned away",
  fullToday: "deep reads today",
};

export function TokenSageAdmin() {
  const [days, setDays] = useState<1 | 7>(1);
  const q = usePolling<TokenSageReport>(`/admin/tokensage?days=${days}`, 120_000);
  return (
    <div className="stack">
      <Load q={q}>
        {(r) => (
          <div className="stack">
            {!r.status.on && (
              <p className="notice">
                TokenSage is off: the scanner's last cycle
                {r.status.scanSeenAt ? <> ({when(r.status.scanSeenAt)})</> : null} didn't ask it anything. Set
                TOKENSAGE_ENABLED=true, TOKENSAGE_API_URL and TOKENSAGE_API_KEY on the scanner worker to turn
                it on.{" "}
                {r.stored.allTime > 0
                  ? "Answers stored earlier are still shown below."
                  : "Nothing has been stored yet."}
              </p>
            )}
            <div className="kpis">
              <Kpi
                label="TokenSage"
                value={r.status.on ? "On" : "Off"}
                sub={r.status.on ? <>last cycle {when(r.status.lastCycleAt)}</> : "scanner not asking"}
                tone={r.status.on ? "ok" : undefined}
              />
              <Kpi
                label={`Stored, last ${days}d`}
                value={n(r.stored.inWindow)}
                sub={
                  <>
                    {n(r.stored.allTime)} kept in all · newest {when(r.stored.newestAt)}
                  </>
                }
              />
              <Kpi
                label="Failed"
                value={share(
                  r.stored.byDepthStatus
                    .filter((g) => g.status === "failed")
                    .reduce((s, g) => s + g.count, 0),
                  r.stored.inWindow,
                )}
                sub={r.failReasons[0] ? `mostly ${r.failReasons[0].label}` : "none"}
              />
              <Kpi
                label="Referent confidence"
                value={
                  r.stored.avgReferentConfidence === null ? "–" : pct(r.stored.avgReferentConfidence * 100)
                }
                sub={`average · X link fit ${r.stored.avgXFit === null ? "–" : pct(r.stored.avgXFit * 100)}`}
              />
              <Kpi
                label="Answer age when stored"
                value={
                  r.stored.medianStoreLagSeconds === null ? "–" : `${n(r.stored.medianStoreLagSeconds)}s`
                }
                sub="median, analysis to our copy"
              />
            </div>
            <Panel
              title="Stored answers"
              actions={
                <WindowPicker options={[1, 7] as (1 | 7)[]} value={days} onChange={setDays} unit="d" />
              }
              note="The scanner's TokenSage counters from its newest cycle, then what was stored in the window picked here (it sets every table on this page except Recent answers)."
            >
              {r.status.lastCycle ? (
                <Table
                  head={["Counter", "Value"]}
                  rows={Object.entries(r.status.lastCycle).map(([k, v]) => [
                    LAST_CYCLE_LABELS[k] ?? k,
                    <span className="num">{n(v)}</span>,
                  ])}
                />
              ) : (
                <p className="muted small">No counters: the last scan cycle ran with TokenSage off.</p>
              )}
              <Table
                head={["Depth", "Result", "Stored"]}
                rows={r.stored.byDepthStatus.map((g) => [
                  g.depth,
                  g.status,
                  <span className="num">{n(g.count)}</span>,
                ])}
                empty="Nothing stored in this window."
              />
            </Panel>
            <Panel
              title="How described coins did"
              note={`Every model alert in the last ${days}d, grouped by what TokenSage says about its coin now. The answer can have arrived after the alert, so this shows what the narrative goes with, not what a model could have known.${r.outcomes.capped ? " Capped at the newest 20,000 alerts." : ""}`}
            >
              <div className="stack">
                <h3>Coverage</h3>
                <Table
                  head={["TokenSage", ...tallyHead]}
                  rows={r.outcomes.byCoverage.map((t) => [t.label, ...tallyCells(t)])}
                  empty="No model alerts in this window."
                />
                <h3>By top category</h3>
                <Table
                  head={["Category", ...tallyHead]}
                  rows={r.outcomes.byCategory.map((t) => [t.label, ...tallyCells(t)])}
                  empty="No described alerts yet."
                />
                <div className="admin-grid">
                  <div>
                    <h3>By X link verdict</h3>
                    <Table
                      head={["Verdict", ...tallyHead]}
                      rows={r.outcomes.byXVerdict.map((t) => [t.label, ...tallyCells(t)])}
                      empty="No deep reads on alerted coins yet."
                    />
                  </div>
                  <div>
                    <h3>By copy status</h3>
                    <Table
                      head={["Copy", ...tallyHead]}
                      rows={r.outcomes.byCopy.map((t) => [t.label, ...tallyCells(t)])}
                      empty="No described alerts yet."
                    />
                  </div>
                </div>
                <h3>By flag</h3>
                <Table
                  head={["Flag", ...tallyHead]}
                  rows={r.outcomes.byFlag.map((t) => [t.label, ...tallyCells(t)])}
                  empty="No described alerts yet."
                />
              </div>
            </Panel>
            <Panel title="What TokenSage sees" note={`Answers stored in the last ${days}d.`}>
              <div className="admin-grid">
                <Counts title="Top-level categories" rows={r.topLevelCategories} />
                <Counts title="Categories" rows={r.categories} />
                <Counts title="Referent kinds" rows={r.referentKinds} />
                <Counts title="Referent supported by" rows={r.referentSupport} />
                <Counts title="Flags" rows={r.flags} />
                <Counts title="X link verdict (deep reads)" rows={r.xVerdicts} />
                <Counts title="Trades against" rows={r.pairKinds} />
                <Counts title="Copies" rows={r.copies} />
                <Counts
                  title="In the news (deep reads; TokenSage expects 4-8% of launches)"
                  rows={r.trend ?? []}
                />
                <Counts
                  title="Trend sources (deep reads)"
                  rows={r.trendSources ?? []}
                  empty="No read has reported its sources yet (rules 0.15.0+)."
                />
                <Counts title="Rules version" rows={r.rulesVersions} />
                <Counts title="Why it failed" rows={r.failReasons} empty="No failures in this window." />
              </div>
            </Panel>
          </div>
        )}
      </Load>
      <RecentNarratives />
    </div>
  );
}

function RecentNarratives() {
  const [status, setStatus] = useState<"" | "complete" | "partial" | "failed">("");
  const [open, setOpen] = useState<string | null>(null);
  const q = usePolling<Narrative[]>(
    `/admin/tokensage/recent?limit=100${status ? `&status=${status}` : ""}`,
    60_000,
  );
  return (
    <Panel
      title="Recent answers"
      note="The newest 100 stored answers. Open one to read TokenSage's whole document."
      actions={
        <div className="segmented" role="tablist" aria-label="Result">
          {(["", "complete", "partial", "failed"] as const).map((s) => (
            <button
              key={s || "all"}
              role="tab"
              aria-selected={s === status}
              className={s === status ? "on" : ""}
              onClick={() => setStatus(s)}
            >
              {s || "all"}
            </button>
          ))}
        </div>
      }
    >
      <Load q={q}>
        {(rows) => (
          <div className="stack">
            <Table
              head={[
                "Stored",
                "Token",
                "Depth",
                "Result",
                "Referent",
                "Categories",
                "Flags",
                "X link",
                "Pair",
                "Copy",
                "",
              ]}
              rows={rows.map((r) => [
                when(r.checkedAt),
                token(r.mintAddress, r.symbol),
                r.depth,
                r.status === "failed" ? (
                  <Tag tone="bad">failed</Tag>
                ) : r.status === "partial" ? (
                  <Tag tone="warn">partial</Tag>
                ) : (
                  <Tag tone="ok">complete</Tag>
                ),
                r.status === "failed" ? (
                  longText(r.failReason)
                ) : r.referentLabel ? (
                  <span title={r.referentSupport.length ? `from ${r.referentSupport.join(", ")}` : undefined}>
                    {r.referentLabel}
                    {r.referentKind ? (
                      <span className="faint">
                        {" "}
                        · {r.referentKind}
                        {r.referentGeneric ? " (kind only)" : ""}
                      </span>
                    ) : null}
                    {r.referentConfidence !== null ? (
                      <span className="faint"> · {pct(r.referentConfidence * 100)}</span>
                    ) : null}
                  </span>
                ) : (
                  "–"
                ),
                (r.categories ?? [])
                  .slice(0, 3)
                  .map((c) => `${c.label} ${pct(c.confidence * 100)}`)
                  .join(", ") || "–",
                r.flags.join(", ") || "–",
                r.xVerdict ? `${r.xVerdict}${r.xFit !== null ? ` ${pct(r.xFit * 100)}` : ""}` : "–",
                r.pairKind ? `${r.pairKind}${r.pairSymbol ? ` (${r.pairSymbol})` : ""}` : "–",
                r.copiesRecent === null ? "–" : r.copiesRecent ? <Tag tone="warn">recent copy</Tag> : "no",
                <button
                  className="ghost small"
                  onClick={() => setOpen(open === r.mintAddress ? null : r.mintAddress)}
                >
                  {open === r.mintAddress ? "Close" : "Open"}
                </button>,
              ])}
              empty="No answers stored yet."
            />
            {open && <NarrativeDocument mint={open} onClose={() => setOpen(null)} />}
          </div>
        )}
      </Load>
    </Panel>
  );
}

function NarrativeDocument({ mint, onClose }: { mint: string; onClose: () => void }) {
  const q = usePolling<
    Narrative & { analysis: unknown; token: { symbol: string | null; name: string | null } | null }
  >(`/admin/tokensage/${mint}`, 600_000);
  return (
    <Panel
      title={`TokenSage on ${q.data?.token?.symbol ?? shortAddress(mint)}`}
      note={mint}
      actions={
        <button className="ghost small" onClick={onClose}>
          Close
        </button>
      }
    >
      <Load q={q}>
        {(d) => (
          <div className="stack">
            {d.summary && <p>{d.summary}</p>}
            <pre className="admin-json">{JSON.stringify(d.analysis ?? null, null, 2)}</pre>
          </div>
        )}
      </Load>
    </Panel>
  );
}

// ---------- Safety screen ----------

interface ScreenRow {
  mint: string;
  symbol: string | null;
  firstSeenAt: string;
  takenAt: string;
  passed: boolean;
  reasons: string[];
  marketCapUsd: number | null;
  freshTop10WalletPct: number | null;
  emptyTop10WalletPct: number | null;
  sniperTop10WalletPct?: number | null;
  top10HolderPct: number | null;
  riskScore: number | null;
}
interface ScreenReport {
  window: { hours: number; since: string };
  discovered: number;
  screened: number;
  passing: number;
  failing: number;
  failingAfterPassing: number;
  reasons: Count[];
  recent: ScreenRow[];
}

const walletPct = (v: number | null) =>
  v === null ? (
    <span className="faint">–</span>
  ) : (
    <span className={`num ${v > 70 ? "down" : ""}`}>{pct(v)}</span>
  );

export function SafetyScreen() {
  const [hours, setHours] = useState<1 | 3 | 6>(1);
  const [show, setShow] = useState<"all" | "failing" | "passing">("all");
  const q = usePolling<ScreenReport>(`/admin/screen?hours=${hours}`, 60_000);
  return (
    <Load q={q}>
      {(s) => {
        const rows = s.recent.filter((r) => show === "all" || (show === "passing") === r.passed);
        return (
          <div className="stack">
            <div className="kpis">
              <Kpi
                label={`Discovered, last ${hours}h`}
                value={n(s.discovered)}
                sub={`${n(s.screened)} reached the mcap band and were screened`}
              />
              <Kpi
                label="Passing now"
                value={n(s.passing)}
                sub={`${share(s.passing, s.screened)} of screened`}
                tone="ok"
              />
              <Kpi
                label="Rejected now"
                value={n(s.failing)}
                sub={`${n(s.failingAfterPassing)} of them passed earlier`}
                tone={s.failing ? "warn" : undefined}
              />
            </div>
            <Panel
              title="Why tokens are rejected"
              note="Each screened token's newest verdict. A token can fail for several reasons at once, so shares add up past 100%."
              actions={
                <WindowPicker
                  options={[1, 3, 6] as (1 | 3 | 6)[]}
                  value={hours}
                  onChange={setHours}
                  unit="h"
                />
              }
            >
              <Table
                head={["Reason", "Tokens", "Share of rejected"]}
                rows={s.reasons.map((r) => [
                  r.label,
                  <span className="num">{n(r.count)}</span>,
                  share(r.count, s.failing),
                ])}
                empty="Nothing rejected in this window."
              />
            </Panel>
            <Panel
              title="Latest verdicts"
              note="The newest 150 screened tokens. Rejected tokens never reach a model or a filter."
              actions={
                <div className="segmented" role="tablist" aria-label="Verdict">
                  {(["all", "failing", "passing"] as const).map((v) => (
                    <button
                      key={v}
                      role="tab"
                      aria-selected={v === show}
                      className={v === show ? "on" : ""}
                      onClick={() => setShow(v)}
                    >
                      {v === "failing" ? "rejected" : v}
                    </button>
                  ))}
                </div>
              }
            >
              <Table
                head={[
                  "Checked",
                  "Token",
                  "Mcap",
                  "Verdict",
                  "Fresh",
                  "Empty",
                  "Snipers",
                  "Top 10",
                  "Risk",
                  "Reasons",
                ]}
                rows={rows.map((r) => [
                  when(r.takenAt),
                  token(r.mint, r.symbol),
                  <span className="num">{usd(r.marketCapUsd)}</span>,
                  r.passed ? <Tag tone="ok">pass</Tag> : <Tag tone="bad">reject</Tag>,
                  walletPct(r.freshTop10WalletPct),
                  walletPct(r.emptyTop10WalletPct),
                  walletPct(r.sniperTop10WalletPct ?? null),
                  r.top10HolderPct === null ? "–" : pct(r.top10HolderPct),
                  r.riskScore === null ? "–" : n(Math.round(r.riskScore)),
                  r.reasons.length ? (
                    <span className="admin-note">{r.reasons.join("; ")}</span>
                  ) : (
                    <span className="faint">–</span>
                  ),
                ])}
                empty="No screened tokens in this window."
              />
            </Panel>
          </div>
        );
      }}
    </Load>
  );
}

// ---------- Filters ----------

interface AdminFilter {
  id: string;
  userId: string;
  walletAddress: string;
  name: string;
  isActive: boolean;
  shareOnLeaderboard: boolean;
  bestRank: number | null;
  deletedAt: string | null;
  createdAt: string;
  criteriaChangedAt: string;
  matches24h: number;
  matches7d: number;
  [criterion: string]: unknown;
}
interface FiltersReport {
  total: number;
  active: number;
  shared: number;
  retired: number;
  filters: AdminFilter[];
}
interface FilterRate {
  filterId: string;
  graded: number;
  hitRate2xPct: number | null;
  hitRate4xPct: number | null;
}

/** The criteria a filter sets, in short words. */
const CRITERIA: [string, string, (v: number) => string][] = [
  ["mcapMin", "mcap ≥", usd],
  ["mcapMax", "mcap ≤", usd],
  ["minScore", "score ≥", (v) => String(v)],
  ["minTokenAgeMinutes", "age ≥", (v) => `${v}m`],
  ["maxTokenAgeMinutes", "age ≤", (v) => `${v}m`],
  ["maxFreshTop10WalletPct", "fresh ≤", (v) => `${v}%`],
  ["maxEmptyTop10WalletPct", "empty ≤", (v) => `${v}%`],
  ["maxSniperTop10WalletPct", "snipers in top 10 ≤", (v) => `${v}%`],
  ["maxTop10HolderPct", "top10 ≤", (v) => `${v}%`],
  ["maxDevWalletPct", "dev ≤", (v) => `${v}%`],
  ["maxRiskScore", "risk ≤", (v) => String(v)],
  ["minVolumeMcapRatio", "vol/mcap ≥", (v) => String(v)],
  ["minHolderGrowthPct", "holders ≥", (v) => `+${v}%`],
  ["minFirstBuyersHolding", "snipers ≥", (v) => `${v}/25`],
  ["maxFirstBuyersHolding", "snipers ≤", (v) => `${v}/25`],
];

function criteria(f: AdminFilter): string {
  const parts = CRITERIA.filter(([k]) => typeof f[k] === "number").map(
    ([k, label, fmt]) => `${label} ${fmt(f[k] as number)}`,
  );
  if (f.excludeCriticalRiskFlags) parts.push("no critical flags");
  const words = f.narrativeKeywords as string[] | undefined;
  if (words?.length) parts.push(`words: ${words.join(", ")}`);
  parts.push(...narrativeCriteriaLines(f as Partial<FilterCriteria>).map((l) => l.toLowerCase()));
  return parts.join(" · ");
}

export function FiltersAdmin() {
  const q = usePolling<FiltersReport>("/admin/filters", 60_000);
  const rates = usePolling<{ filterMatches: { byFilter: FilterRate[] } }>("/admin/hit-rates?days=7", 120_000);
  const [search, setSearch] = useState("");
  const byId = new Map((rates.data?.filterMatches.byFilter ?? []).map((r) => [r.filterId, r]));
  return (
    <Load q={q}>
      {(d) => {
        const needle = search.trim().toLowerCase();
        const rows = d.filters.filter(
          (f) =>
            !needle ||
            f.name.toLowerCase().includes(needle) ||
            f.walletAddress.toLowerCase().includes(needle),
        );
        return (
          <div className="stack">
            <div className="kpis">
              <Kpi label="Saved filters" value={n(d.total)} sub={`${n(d.retired)} retired`} />
              <Kpi label="Active" value={n(d.active)} />
              <Kpi label="Shared on Top filters" value={n(d.shared)} />
              <Kpi
                label="Alerts, 7d"
                value={n(d.filters.reduce((s, f) => s + f.matches7d, 0))}
                sub={`${n(d.filters.reduce((s, f) => s + f.matches24h, 0))} in 24h`}
              />
            </div>
            <Panel
              title="Every filter"
              note="All users' filters, newest first, with alerts sent and the 7-day hit rate (2x within 15 minutes)."
              actions={
                <input
                  placeholder="Search name or wallet"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              }
            >
              <Table
                head={[
                  "Owner",
                  "Name",
                  "State",
                  "Alerts 24h",
                  "Alerts 7d",
                  "7d 2x / 4x",
                  "Best rank",
                  "Settings",
                  "Created",
                ]}
                rows={rows.map((f) => {
                  const r = byId.get(f.id);
                  return [
                    <Wallet address={f.walletAddress} />,
                    <b>{f.name}</b>,
                    f.deletedAt ? (
                      <Tag tone="muted">retired</Tag>
                    ) : f.isActive ? (
                      <Tag tone="ok">{f.shareOnLeaderboard ? "active · shared" : "active"}</Tag>
                    ) : (
                      <Tag tone="muted">{f.shareOnLeaderboard ? "off · shared" : "off"}</Tag>
                    ),
                    <span className="num">{n(f.matches24h)}</span>,
                    <span className="num">{n(f.matches7d)}</span>,
                    r && r.graded > 0 ? (
                      <span className="num" title={`${r.graded} graded`}>
                        {pct(r.hitRate2xPct, 1)} / {pct(r.hitRate4xPct, 1)}
                      </span>
                    ) : (
                      "–"
                    ),
                    f.bestRank === null ? "–" : `#${f.bestRank}`,
                    <span className="admin-note">{criteria(f) || "–"}</span>,
                    when(f.createdAt),
                  ];
                })}
                empty="No filters match."
              />
            </Panel>
          </div>
        );
      }}
    </Load>
  );
}

// ---------- Outside lookups (shown on the Worker section) ----------

export function Lookups(): ReactNode {
  const q = usePolling<{ table: string; lastHour: number; last24h: number }[]>("/admin/lookups", 300_000);
  return (
    <Panel
      title="Outside lookups"
      note="Mints and wallets each service answered for, from the worker's cache tables. A re-check of the same mint counts once, so this is a floor on calls, not a bill. Cached for 5 minutes."
    >
      <Load q={q}>
        {(rows) => (
          <Table
            head={["Service", "Last hour", "Last 24h"]}
            rows={rows.map((r) => [
              r.table,
              <span className="num">{n(r.lastHour)}</span>,
              <span className="num">{n(r.last24h)}</span>,
            ])}
          />
        )}
      </Load>
    </Panel>
  );
}
