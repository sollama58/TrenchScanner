import { useState, type ReactNode } from "react";
import { ApiError, api, del, downloadFile, patch, post } from "../api";
import { Skeleton } from "../components/Charts";
import { ShieldIcon } from "../components/Icons";
import { usePolling, type Loadable } from "../hooks";
import { ago, multiple, pct, shortAddress, usd } from "../format";

/**
 * The admin panel: everything about the running system in one place, for the wallets in
 * ADMIN_WALLET_ADDRESSES (the tab only shows for them, and every /admin route checks again
 * server-side). Sections load only while open, so an admin browsing Overview doesn't pay for the
 * storage report.
 */

const SECTIONS = [
  { id: "overview", label: "Overview" },
  { id: "worker", label: "Worker" },
  { id: "alerts", label: "Alerts" },
  { id: "users", label: "Users" },
  { id: "access", label: "Access" },
  { id: "ai", label: "AI" },
  { id: "backups", label: "Backups" },
  { id: "database", label: "Database" },
  { id: "api", label: "API" },
  { id: "config", label: "Config" },
] as const;
type Section = (typeof SECTIONS)[number]["id"];

export function AdminTab({ goTo }: { goTo: (tab: "model") => void }) {
  const [section, setSection] = useState<Section>("overview");
  return (
    <div className="stack admin">
      <section className="panel">
        <header className="section-head admin-head">
          <div>
            <span className="eyebrow">
              <ShieldIcon size={13} /> Admin
            </span>
            <h2>Admin panel</h2>
            <p className="muted small">
              The whole system at a glance. Model leaderboard, evolution and feature health are on the{" "}
              <a href="#model" onClick={() => goTo("model")}>
                Models tab
              </a>
              .
            </p>
          </div>
        </header>
        <div className="segmented admin-sections" role="tablist" aria-label="Admin section">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              role="tab"
              aria-selected={section === s.id}
              className={section === s.id ? "on" : ""}
              onClick={() => setSection(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </section>
      {section === "overview" && <Overview />}
      {section === "worker" && <Worker />}
      {section === "alerts" && <Alerts />}
      {section === "users" && <Users />}
      {section === "access" && <Access />}
      {section === "ai" && <Ai />}
      {section === "backups" && <Backups />}
      {section === "database" && <Database />}
      {section === "api" && <ApiInstance />}
      {section === "config" && <Config />}
    </div>
  );
}

// ---------- shared bits ----------

function Panel({
  title,
  note,
  children,
  actions,
}: {
  title: string;
  note?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="panel">
      <header className="section-head">
        <div>
          <h2>{title}</h2>
          {note && <p className="muted small">{note}</p>}
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}

/** Data, a skeleton while it first loads, or the error. */
function Load<T>({ q, children }: { q: Loadable<T>; children: (data: T) => ReactNode }) {
  if (q.data) return <div className={q.stale ? "stale" : ""}>{children(q.data)}</div>;
  if (q.error) return <p className="error">Couldn't load: {q.error.message}</p>;
  return <Skeleton lines={4} />;
}

function Kpi({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "ok" | "warn";
}) {
  return (
    <div className={`panel kpi${tone ? ` admin-${tone}` : ""}`}>
      <span className="eyebrow">{label}</span>
      <span className="kpi-value num">{value}</span>
      {sub && <span className="muted small">{sub}</span>}
    </div>
  );
}

function Table({
  head,
  rows,
  empty = "Nothing yet.",
}: {
  head: string[];
  rows: ReactNode[][];
  empty?: string;
}) {
  if (rows.length === 0) return <p className="muted small">{empty}</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const n = (v: number | null | undefined) => (v === null || v === undefined ? "–" : v.toLocaleString());
const ms = (v: number | null | undefined) =>
  v === null || v === undefined
    ? "–"
    : v >= 60_000
      ? `${(v / 60_000).toFixed(1)}m`
      : v >= 1000
        ? `${(v / 1000).toFixed(1)}s`
        : `${Math.round(v)}ms`;
const when = (iso: string | null | undefined) =>
  iso ? <span title={new Date(iso).toLocaleString()}>{ago(iso)}</span> : <span className="faint">never</span>;
const Tag = ({ tone, children }: { tone: "ok" | "warn" | "bad" | "muted"; children: ReactNode }) => (
  <span className={`admin-tag-${tone}`}>{children}</span>
);

// ---------- Backups ----------

interface ModelBackupRow {
  id: string;
  createdAt: string;
  kind: string;
  note: string | null;
  pinned: boolean;
  modelCount: number;
  sizeBytes: number;
  offsiteKey: string | null;
  offsiteAt: string | null;
  offsiteError: string | null;
  restoredAt: string | null;
}

interface ModelBackups {
  backups: ModelBackupRow[];
  keepWeeks: number;
  offsiteConfigured: boolean | null;
  lastCheckAt: string | null;
  lastError: string | null;
}

const KIND_LABEL: Record<string, string> = {
  weekly: "Weekly",
  manual: "Manual",
  "pre-restore": "Before a restore",
  imported: "Imported",
};

const kb = (bytes: number) =>
  bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;

/**
 * Model backups (curation/modelBackup.ts): every running model's weights, cutoffs, calibration,
 * recipe and record, snapshotted weekly by the trainer. Download one to keep it anywhere; import a
 * downloaded file to bring it back after losing the database; restore puts it back in charge.
 */
function Backups() {
  const q = usePolling<ModelBackups>("/admin/model-backups", 60_000);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const run = async (what: () => Promise<string>) => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await what());
      q.reload();
    } catch (e) {
      setResult(`Failed: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };
  const takeNow = () =>
    run(async () => {
      const b = await post<ModelBackupRow>("/admin/model-backups", {});
      return `Backed up ${b.modelCount} models (${kb(b.sizeBytes)}).`;
    });
  const importFile = (file: File) =>
    run(async () => {
      const b = await api<ModelBackupRow>("/admin/model-backups/import", {
        method: "POST",
        body: file,
        headers: { "content-type": "application/gzip" },
      });
      return `Imported ${b.modelCount} models. Restore it from the list below to put them back in charge.`;
    });
  const restore = (b: ModelBackupRow) => {
    if (
      !window.confirm(
        `Restore the ${b.modelCount} models from ${new Date(b.createdAt).toLocaleString()}?\n\n` +
          "They replace the running models straight away. What runs now is backed up first, so this can be undone. " +
          "The next training run retrains the restored recipes on fresh data.",
      )
    )
      return;
    void run(async () => {
      const r = await post<{ models: number; lanesRestored: number }>(
        `/admin/model-backups/${b.id}/restore`,
        {
          confirm: true,
        },
      );
      return `Restored ${r.models} models and ${r.lanesRestored} recipes. The previous models were backed up first.`;
    });
  };
  return (
    <div className="stack">
      <Panel
        title="Model backups"
        note="Every running model, its recipe, cutoffs, calibration and record, backed up by the trainer once a week. Pinned backups are never deleted."
        actions={
          <div className="admin-form">
            <button className="button primary" disabled={busy} onClick={() => void takeNow()}>
              Back up now
            </button>
            <label className="button">
              Import a file
              <input
                type="file"
                accept=".gz,.json,application/gzip,application/json"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void importFile(file);
                }}
              />
            </label>
          </div>
        }
      >
        {result && <p className="small muted">{result}</p>}
        <Load q={q}>
          {(d) => (
            <div className="stack">
              <p className="small muted">
                Keeping the newest {d.keepWeeks} weekly backups. Off-site copies:{" "}
                {d.offsiteConfigured === true ? (
                  <Tag tone="ok">on</Tag>
                ) : d.offsiteConfigured === false ? (
                  <Tag tone="warn">off - backups live in the database only</Tag>
                ) : (
                  <Tag tone="muted">not reported yet</Tag>
                )}{" "}
                · last check {when(d.lastCheckAt)}
                {d.lastError && (
                  <>
                    {" "}
                    · <Tag tone="bad">{d.lastError}</Tag>
                  </>
                )}
              </p>
              <Table
                head={["Taken", "Kind", "Models", "Size", "Off-site", "Note", ""]}
                empty="No backups yet. The trainer takes the first one within an hour of deploying."
                rows={d.backups.map((b) => [
                  when(b.createdAt),
                  <>
                    {KIND_LABEL[b.kind] ?? b.kind}
                    {b.pinned && (
                      <>
                        {" "}
                        <Tag tone="ok">pinned</Tag>
                      </>
                    )}
                    {b.restoredAt && (
                      <>
                        {" "}
                        <Tag tone="muted">restored {ago(b.restoredAt)}</Tag>
                      </>
                    )}
                  </>,
                  n(b.modelCount),
                  kb(b.sizeBytes),
                  b.offsiteKey ? (
                    <span title={b.offsiteKey}>{when(b.offsiteAt)}</span>
                  ) : b.offsiteError ? (
                    <Tag tone="bad">
                      <span title={b.offsiteError}>failed</span>
                    </Tag>
                  ) : (
                    <span className="faint">–</span>
                  ),
                  b.note ?? "–",
                  <span className="admin-actions">
                    <button
                      className="ghost small"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await downloadFile(
                            `/admin/model-backups/${b.id}/download`,
                            `model-backup-${b.id}.json.gz`,
                          );
                          return "Downloaded.";
                        })
                      }
                    >
                      Download
                    </button>
                    <button
                      className="ghost small"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await patch(`/admin/model-backups/${b.id}`, { pinned: !b.pinned });
                          return b.pinned ? "Unpinned." : "Pinned: this backup is kept for good.";
                        })
                      }
                    >
                      {b.pinned ? "Unpin" : "Pin"}
                    </button>
                    <button className="ghost small" disabled={busy} onClick={() => restore(b)}>
                      Restore
                    </button>
                  </span>,
                ])}
              />
            </div>
          )}
        </Load>
      </Panel>
    </div>
  );
}

// ---------- Overview ----------

interface Overview {
  users: { total: number; new24h: number; new7d: number; admins: number };
  access: { activeSubscriptions: number; whitelisted: number; linkedDevices: number; burns7d: number };
  activeFilters: number;
  curatedAlerts: { last24h: number; last7d: number };
  aiReviews24h: number;
  databaseMb: number;
  worker: { jobs: number; stale: string[]; hung: string[]; failing: string[] };
  api: { uptimeSeconds: number; stream: boolean };
  targets: { hitRate2xPct: number; hitRate4xPct: number };
}

function Overview() {
  const q = usePolling<Overview>("/admin/overview", 30_000);
  const hits = usePolling<HitRates>("/admin/hit-rates?days=7", 120_000);
  return (
    <Load q={q}>
      {(o) => {
        const problems = [...new Set([...o.worker.hung, ...o.worker.stale])];
        const total = hits.data?.curatedAlerts.total;
        return (
          <div className="stack">
            <div className="kpis">
              <Kpi
                label="Users"
                value={n(o.users.total)}
                sub={`+${o.users.new24h} today · +${o.users.new7d} this week`}
              />
              <Kpi
                label="Paying access"
                value={n(o.access.activeSubscriptions)}
                sub={`${o.access.whitelisted} whitelisted · ${o.access.burns7d} burns this week`}
              />
              <Kpi
                label="Model alerts"
                value={n(o.curatedAlerts.last24h)}
                sub={`last 24h · ${n(o.curatedAlerts.last7d)} this week`}
              />
              <Kpi
                label="7d hit rate (2x / 4x)"
                value={total ? `${pct(total.hitRate2xPct)} / ${pct(total.hitRate4xPct)}` : "–"}
                sub={
                  total
                    ? `${total.graded} graded · target ${o.targets.hitRate2xPct}% / ${o.targets.hitRate4xPct}%`
                    : "loading"
                }
                tone={
                  total?.verdict === "meets-targets"
                    ? "ok"
                    : total?.verdict === "below-targets"
                      ? "warn"
                      : undefined
                }
              />
              <Kpi
                label="Worker jobs"
                value={problems.length === 0 ? "Healthy" : `${problems.length} lagging`}
                sub={problems.length ? problems.join(", ") : `${o.worker.jobs} jobs reporting`}
                tone={problems.length ? "warn" : "ok"}
              />
              <Kpi
                label="Jobs with errors"
                value={n(o.worker.failing.length)}
                sub={o.worker.failing.join(", ") || "none"}
                tone={o.worker.failing.length ? "warn" : "ok"}
              />
              <Kpi
                label="Database"
                value={`${(o.databaseMb / 1024).toFixed(2)} GB`}
                sub={`${o.activeFilters} active filters`}
              />
              <Kpi
                label="API"
                value={`${Math.round(o.api.uptimeSeconds / 3600)}h up`}
                sub={`${o.api.stream ? "push stream connected" : "push stream DOWN"} · ${o.aiReviews24h} AI reviews 24h · ${o.access.linkedDevices} phones`}
                tone={o.api.stream ? undefined : "warn"}
              />
            </div>
          </div>
        );
      }}
    </Load>
  );
}

// ---------- Worker ----------

interface Job {
  job: string;
  role: string | null;
  lastRunAt: string;
  lastSuccessAt: string | null;
  lastError: string | null;
  stale: boolean;
  hung: boolean;
  runningForMs: number | null;
  lastRun:
    | ({ durationMs?: number; stagesMs?: Record<string, number>; rpcCalls?: Record<string, number> } & Record<
        string,
        unknown
      >)
    | null;
  runningStagesMs: Record<string, number> | null;
}

function Worker() {
  const q = usePolling<{ jobs: Job[] }>("/admin/worker", 15_000);
  return (
    <Load q={q}>
      {(d) => (
        <div className="stack">
          <Panel
            title="Jobs"
            note="Every scheduled job's last run, from the worker heartbeats. Refreshes every 15s."
          >
            <Table
              head={["Job", "Worker", "State", "Last run", "Last success", "Took", "Error"]}
              rows={d.jobs.map((j) => [
                <b>{j.job}</b>,
                j.role ?? "–",
                j.hung ? (
                  <Tag tone="bad">hung {ms(j.runningForMs)}</Tag>
                ) : j.runningForMs !== null ? (
                  <Tag tone="ok">running {ms(j.runningForMs)}</Tag>
                ) : j.stale ? (
                  <Tag tone="warn">stale</Tag>
                ) : j.lastError ? (
                  <Tag tone="warn">failed</Tag>
                ) : (
                  <Tag tone="ok">ok</Tag>
                ),
                when(j.lastRunAt),
                when(j.lastSuccessAt),
                ms(j.lastRun?.durationMs),
                j.lastError ? (
                  <span className="admin-error">{j.lastError}</span>
                ) : (
                  <span className="faint">–</span>
                ),
              ])}
            />
          </Panel>
          {d.jobs
            .filter(
              (j) =>
                j.lastRun && (j.lastRun.stagesMs || j.lastRun.rpcCalls || Object.keys(j.lastRun).length > 1),
            )
            .map((j) => {
              const counts = Object.entries(j.lastRun!).filter(
                ([k, v]) => typeof v === "number" && k !== "durationMs",
              ) as [string, number][];
              const stages = Object.entries(j.runningStagesMs ?? j.lastRun!.stagesMs ?? {}).sort(
                (a, b) => b[1] - a[1],
              );
              const rpc = Object.entries(j.lastRun!.rpcCalls ?? {}).sort((a, b) => b[1] - a[1]);
              return (
                <Panel
                  key={j.job}
                  title={`${j.job}: last run`}
                  note={
                    j.runningStagesMs
                      ? "Run in progress: stages finished so far."
                      : `Took ${ms(j.lastRun!.durationMs)}.`
                  }
                >
                  <div className="admin-grid">
                    {stages.length > 0 && (
                      <Table
                        head={["Stage", "Time"]}
                        rows={stages.map(([k, v]) => [k, <span className="num">{ms(v)}</span>])}
                      />
                    )}
                    {rpc.length > 0 && (
                      <Table
                        head={["Helius RPC method", "Calls"]}
                        rows={[
                          ...rpc.map(([k, v]) => [k, <span className="num">{n(v)}</span>]),
                          [<b>total</b>, <b className="num">{n(rpc.reduce((a, [, v]) => a + v, 0))}</b>],
                        ]}
                      />
                    )}
                    {counts.length > 0 && (
                      <Table
                        head={["Count", "Value"]}
                        rows={counts.map(([k, v]) => [k, <span className="num">{n(v)}</span>])}
                      />
                    )}
                  </div>
                </Panel>
              );
            })}
        </div>
      )}
    </Load>
  );
}

// ---------- Alerts ----------

interface Rated {
  calls: number;
  graded: number;
  pending: number;
  won2x: number;
  won4x: number;
  hitRate2xPct: number | null;
  hitRate4xPct: number | null;
  verdict: "meets-targets" | "below-targets" | "insufficient-data";
}

interface HitRates {
  targets: { hitRate2xPct: number; hitRate4xPct: number };
  curatedAlerts: {
    total: Rated;
    bySource: (Rated & { source: string })[];
    byModel: (Rated & { model: string | null })[];
    byTier: (Rated & { tier: string | null })[];
  };
  shadowEmissions: { total: Rated; bySource: (Rated & { source: string })[] };
  curatorConfidenceBands: (Rated & { side: string; band: number })[];
  aiReviewer: {
    mode: string;
    buys: Rated;
    allReviewed: Rated;
    liftPts: number | null;
    brier: number | null;
    curatorBrier: number | null;
  };
  filterMatches: {
    total: Rated;
    filterCount: number;
    byFilter: (Rated & { filterId: string; name: string })[];
  };
  samples: { byKind: (Rated & { kind: string })[]; newestAnchorAt: string | null; lastHourRows: number };
}

interface AdminAlert {
  id: string;
  createdAt: string;
  source: string;
  model: string | null;
  modelName: string | null;
  confidence: number;
  tier: string | null;
  calibratedPct: number | null;
  anchorMcapUsd: number;
  peak1hReturnPct: number | null;
  maxDrawdown1hPct: number | null;
  hit2xIn1h: boolean | null;
  hit4xIn1h: boolean | null;
  disqualified: boolean | null;
  outcomeFinalizedAt: string | null;
  symbol: string | null;
  mint: string;
  ai: { decision: string | null; probability2x: number | null } | null;
}

const rateHead = ["Calls", "Graded", "Pending", "2x", "4x", "Verdict"];
const rateCells = (r: Rated) => [
  n(r.calls),
  n(r.graded),
  n(r.pending),
  <span className="num">{pct(r.hitRate2xPct, 1)}</span>,
  <span className="num">{pct(r.hitRate4xPct, 1)}</span>,
  r.verdict === "meets-targets" ? (
    <Tag tone="ok">meets</Tag>
  ) : r.verdict === "below-targets" ? (
    <Tag tone="warn">below</Tag>
  ) : (
    <Tag tone="muted">too few</Tag>
  ),
];

function Alerts() {
  const [days, setDays] = useState(7);
  const q = usePolling<HitRates>(`/admin/hit-rates?days=${days}`, 120_000);
  const recent = usePolling<AdminAlert[]>("/admin/alerts?limit=50", 30_000);
  return (
    <div className="stack">
      <Panel
        title="Hit rates"
        note="Graded on the production rules: 2x (goal 4x) within an hour of a realistic fill, a 50% drop first is a loss."
        actions={
          <div className="segmented" role="tablist" aria-label="Window">
            {[1, 7, 30, 90].map((d) => (
              <button key={d} className={d === days ? "on" : ""} onClick={() => setDays(d)}>
                {d}d
              </button>
            ))}
          </div>
        }
      >
        <Load q={q}>
          {(h) => (
            <div className="stack">
              <h3>Model alerts by model</h3>
              <Table
                head={["Model", ...rateHead]}
                rows={[
                  [<b>All</b>, ...rateCells(h.curatedAlerts.total)],
                  ...h.curatedAlerts.byModel.map((r) => [r.model ?? "(pre-contest)", ...rateCells(r)]),
                ]}
              />
              <h3>By tier and source</h3>
              <Table
                head={["Group", ...rateHead]}
                rows={[
                  ...h.curatedAlerts.byTier.map((r) => [`tier: ${r.tier ?? "none"}`, ...rateCells(r)]),
                  ...h.curatedAlerts.bySource.map((r) => [`source: ${r.source}`, ...rateCells(r)]),
                  ...h.shadowEmissions.bySource.map((r) => [`shadow: ${r.source}`, ...rateCells(r)]),
                ]}
              />
              <h3>By model confidence</h3>
              <Table
                head={["Side", "Band", ...rateHead]}
                rows={h.curatorConfidenceBands.map((r) => [
                  r.side,
                  `${r.band}-${r.band + 9}`,
                  ...rateCells(r),
                ])}
              />
              <h3>Filter matches</h3>
              <Table
                head={["Filter", ...rateHead]}
                rows={[
                  [<b>All {h.filterMatches.filterCount} filters</b>, ...rateCells(h.filterMatches.total)],
                  ...h.filterMatches.byFilter.map((r) => [r.name, ...rateCells(r)]),
                ]}
              />
              <h3>Training samples</h3>
              <p className="muted small">
                Newest sample {when(h.samples.newestAnchorAt)} · {n(h.samples.lastHourRows)} in the last hour.
                The "event" kind is the base rate every model has to beat.
              </p>
              <Table
                head={["Kind", ...rateHead]}
                rows={h.samples.byKind.map((r) => [r.kind, ...rateCells(r)])}
              />
            </div>
          )}
        </Load>
      </Panel>
      <Panel title="Recent model alerts" note="Every model's last 50 calls, newest first.">
        <Load q={recent}>
          {(rows) => (
            <Table
              head={[
                "When",
                "Token",
                "Model",
                "Conf.",
                "Tier",
                "Mcap",
                "Peak 1h",
                "Drawdown",
                "Result",
                "AI",
              ]}
              rows={rows.map((a) => [
                when(a.createdAt),
                <a href={`https://dexscreener.com/solana/${a.mint}`} target="_blank" rel="noreferrer">
                  {a.symbol ?? shortAddress(a.mint)}
                </a>,
                a.modelName ?? a.model ?? a.source,
                <span className="num">{Math.round(a.confidence)}</span>,
                a.tier ?? "–",
                <span className="num">{usd(a.anchorMcapUsd)}</span>,
                <span className="num">{multiple(a.peak1hReturnPct)}</span>,
                <span className="num">{pct(a.maxDrawdown1hPct)}</span>,
                a.disqualified ? (
                  <Tag tone="muted">disqualified</Tag>
                ) : a.hit4xIn1h ? (
                  <Tag tone="ok">4x</Tag>
                ) : a.hit2xIn1h ? (
                  <Tag tone="ok">2x</Tag>
                ) : a.outcomeFinalizedAt ? (
                  <Tag tone="bad">miss</Tag>
                ) : (
                  <Tag tone="muted">open</Tag>
                ),
                a.ai
                  ? `${a.ai.decision ?? "error"}${a.ai.probability2x !== null ? ` ${Math.round(a.ai.probability2x * 100)}%` : ""}`
                  : "–",
              ])}
            />
          )}
        </Load>
      </Panel>
    </div>
  );
}

// ---------- Users ----------

interface Account {
  id: string;
  walletAddress: string;
  createdAt: string;
  access: "admin" | "whitelist" | "subscription" | "none";
  subscription: { expiresAt: string; source: string } | null;
  filters: number;
  activeFilters: number;
  burns: number;
  devices: number;
  lastDeviceSeenAt: string | null;
  feed: { followBest: boolean; models: string[]; showModelAlerts: boolean };
}

function Users() {
  const q = usePolling<Account[]>("/admin/accounts?limit=200", 60_000);
  const [filter, setFilter] = useState("");
  return (
    <Panel
      title="Users"
      note="Newest 200 accounts with their access and how they use the feed."
      actions={
        <input placeholder="Search wallet" value={filter} onChange={(e) => setFilter(e.target.value)} />
      }
    >
      <Load q={q}>
        {(rows) => (
          <Table
            head={["Wallet", "Joined", "Access", "Expires", "Filters", "Burns", "Phones", "Feed"]}
            rows={rows
              .filter((u) => u.walletAddress.toLowerCase().includes(filter.trim().toLowerCase()))
              .map((u) => [
                <Wallet address={u.walletAddress} />,
                when(u.createdAt),
                <Tag tone={u.access === "none" ? "muted" : "ok"}>{u.access}</Tag>,
                u.subscription ? (
                  <span title={u.subscription.source}>
                    {new Date(u.subscription.expiresAt).toLocaleDateString()}
                  </span>
                ) : (
                  "–"
                ),
                `${u.activeFilters} / ${u.filters}`,
                n(u.burns),
                u.devices ? <span title={`last seen ${ago(u.lastDeviceSeenAt)}`}>{u.devices}</span> : "0",
                !u.feed.showModelAlerts
                  ? "filters only"
                  : u.feed.followBest
                    ? "best model"
                    : u.feed.models.join(", ") || "default",
              ])}
          />
        )}
      </Load>
    </Panel>
  );
}

function Wallet({ address }: { address: string }) {
  return (
    <a
      className="num"
      href={`https://solscan.io/account/${address}`}
      target="_blank"
      rel="noreferrer"
      title={address}
    >
      {shortAddress(address)}
    </a>
  );
}

// ---------- Access (subscriptions, burns, whitelist) ----------

interface SubStats {
  activeSubscriptions: number;
  expiredSubscriptions: number;
  whitelisted: number;
  totalBurns: number;
  unattributedBurns: number;
  totalMonthsCredited: number;
  totalRawBurned: string;
  scanCursorUpdatedAt: string | null;
}
interface Sub {
  walletAddress: string;
  expiresAt: string;
  source: string;
  burnCount: number;
}
interface Burn {
  signature: string;
  burnerWallet: string;
  monthsCredited: number;
  blockTime: string | null;
  creditedAt: string | null;
  discoveredBy: string;
  linkedWallet: string | null;
}
interface WhitelistEntry {
  walletAddress: string;
  note: string | null;
  expiresAt: string | null;
  addedBy: string | null;
  createdAt: string;
}

function Access() {
  const stats = usePolling<SubStats>("/admin/subscriptions/stats", 60_000);
  const subs = usePolling<Sub[]>("/admin/subscriptions?limit=200", 60_000);
  const burns = usePolling<Burn[]>("/admin/subscriptions/burns?limit=100", 60_000);
  const whitelist = usePolling<WhitelistEntry[]>("/admin/whitelist", 60_000);
  const reloadAll = () => {
    stats.reload();
    subs.reload();
    whitelist.reload();
  };
  return (
    <div className="stack">
      <Load q={stats}>
        {(s) => (
          <div className="kpis">
            <Kpi
              label="Active subscriptions"
              value={n(s.activeSubscriptions)}
              sub={`${s.expiredSubscriptions} lapsed`}
            />
            <Kpi label="Whitelisted" value={n(s.whitelisted)} />
            <Kpi
              label="Burns"
              value={n(s.totalBurns)}
              sub={`${s.totalMonthsCredited} months credited · ${s.unattributedBurns} unattributed`}
              tone={s.unattributedBurns ? "warn" : undefined}
            />
            <Kpi label="Burn scan" value={when(s.scanCursorUpdatedAt)} sub="cursor last moved" />
          </div>
        )}
      </Load>
      <Levers onDone={reloadAll} />
      <Panel title="Subscriptions">
        <Load q={subs}>
          {(rows) => (
            <Table
              head={["Wallet", "Expires", "Source", "Burns", ""]}
              rows={rows.map((s) => [
                <Wallet address={s.walletAddress} />,
                new Date(s.expiresAt) > new Date() ? (
                  new Date(s.expiresAt).toLocaleDateString()
                ) : (
                  <Tag tone="muted">lapsed {ago(s.expiresAt)}</Tag>
                ),
                s.source,
                n(s.burnCount),
                <RevokeButton wallet={s.walletAddress} onDone={reloadAll} />,
              ])}
            />
          )}
        </Load>
      </Panel>
      <Panel title="Whitelist">
        <Load q={whitelist}>
          {(rows) => (
            <Table
              head={["Wallet", "Note", "Expires", "Added by", "Added", ""]}
              rows={rows.map((w) => [
                <Wallet address={w.walletAddress} />,
                w.note ?? "–",
                w.expiresAt ? new Date(w.expiresAt).toLocaleDateString() : "never",
                w.addedBy ? shortAddress(w.addedBy) : "–",
                when(w.createdAt),
                <ConfirmButton
                  label="Remove"
                  confirm={`Remove ${shortAddress(w.walletAddress)} from the whitelist?`}
                  run={() => del(`/admin/whitelist/${encodeURIComponent(w.walletAddress)}`)}
                  onDone={reloadAll}
                />,
              ])}
            />
          )}
        </Load>
      </Panel>
      <Panel title="Burn ledger" note="Newest 100 burns.">
        <Load q={burns}>
          {(rows) => (
            <Table
              head={["When", "Burner", "Credited to", "Months", "Found by", "Tx"]}
              rows={rows.map((b) => [
                when(b.blockTime ?? b.creditedAt),
                <Wallet address={b.burnerWallet} />,
                b.linkedWallet ? <Wallet address={b.linkedWallet} /> : <Tag tone="warn">unattributed</Tag>,
                n(b.monthsCredited),
                b.discoveredBy,
                <a href={`https://solscan.io/tx/${b.signature}`} target="_blank" rel="noreferrer">
                  {shortAddress(b.signature)}
                </a>,
              ])}
            />
          )}
        </Load>
      </Panel>
    </div>
  );
}

function errorText(e: unknown) {
  return e instanceof ApiError || e instanceof Error ? e.message : String(e);
}

function ConfirmButton({
  label,
  confirm,
  run,
  onDone,
}: {
  label: string;
  confirm: string;
  run: () => Promise<unknown>;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="ghost small"
      disabled={busy}
      onClick={async () => {
        if (!window.confirm(confirm)) return;
        setBusy(true);
        try {
          await run();
          onDone();
        } catch (e) {
          window.alert(errorText(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      {label}
    </button>
  );
}

function RevokeButton({ wallet, onDone }: { wallet: string; onDone: () => void }) {
  return (
    <ConfirmButton
      label="Revoke"
      confirm={`Revoke ${shortAddress(wallet)}'s subscription now? Their burns stay on record.`}
      run={() => del(`/admin/subscriptions/${encodeURIComponent(wallet)}`)}
      onDone={onDone}
    />
  );
}

/** Grant days of access, or whitelist a wallet. */
function Levers({ onDone }: { onDone: () => void }) {
  const [wallet, setWallet] = useState("");
  const [days, setDays] = useState("30");
  const [note, setNote] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (what: "grant" | "whitelist") => {
    setBusy(true);
    setResult(null);
    try {
      if (what === "grant") {
        const r = await post<{ expiresAt: string }>("/admin/subscriptions/grant", {
          walletAddress: wallet.trim(),
          days: Number(days),
        });
        setResult(`Granted. Access now runs to ${new Date(r.expiresAt).toLocaleString()}.`);
      } else {
        await post("/admin/whitelist", { walletAddress: wallet.trim(), note: note.trim() || undefined });
        setResult("Whitelisted.");
      }
      onDone();
    } catch (e) {
      setResult(`Failed: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel
      title="Give access"
      note="Grant extends any current subscription. Whitelisting gives access with no end date."
    >
      <div className="admin-form">
        <input placeholder="Wallet address" value={wallet} onChange={(e) => setWallet(e.target.value)} />
        <input
          className="admin-days"
          type="number"
          min={1}
          max={730}
          value={days}
          onChange={(e) => setDays(e.target.value)}
          aria-label="Days"
        />
        <button
          className="button primary"
          disabled={busy || !wallet.trim()}
          onClick={() => void act("grant")}
        >
          Grant {days || 0} days
        </button>
        <input
          placeholder="Whitelist note (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button className="button" disabled={busy || !wallet.trim()} onClick={() => void act("whitelist")}>
          Whitelist
        </button>
      </div>
      {result && <p className="small muted">{result}</p>}
      <p className="small faint">
        Backup:{" "}
        <a
          href="#"
          onClick={async (e) => {
            e.preventDefault();
            const data = await api<unknown>("/admin/subscriptions/export");
            const url = URL.createObjectURL(
              new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
            );
            const a = document.createElement("a");
            a.href = url;
            a.download = `trenchscanner-access-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          download whitelist, subscriptions and burns as JSON
        </a>
      </p>
    </Panel>
  );
}

// ---------- AI ----------

interface AiReport {
  config: {
    mode: string;
    apiKeySet: boolean;
    reviewModel: string;
    textModel: string;
    textFeatures: unknown;
    playbookEvolution: unknown;
  };
  reviews: {
    window: string;
    reviews: number;
    inputTokens: number;
    outputTokens: number;
    avgLatencyMs: number | null;
    byDecision: Record<string, number>;
  }[];
  replays7d: { runs: number; requests: number; inputTokens: number; outputTokens: number };
  recent: {
    createdAt: string;
    mode: string;
    model: string;
    decision: string | null;
    probability2x: number | null;
    error: string | null;
    latencyMs: number;
    symbol: string | null;
    mint: string;
  }[];
}

function Ai() {
  const q = usePolling<AiReport>("/admin/ai", 60_000);
  const hits = usePolling<HitRates>("/admin/hit-rates?days=30", 120_000);
  return (
    <Load q={q}>
      {(a) => (
        <div className="stack">
          {!a.config.apiKeySet && (
            <p className="notice">
              No ANTHROPIC_API_KEY on this API service, so the AI reviewer isn't running here. Add it on the
              Render worker to turn it on.
            </p>
          )}
          <Panel
            title="AI reviewer"
            note={`Mode ${a.config.mode} · model ${a.config.reviewModel} · text model ${a.config.textModel}`}
          >
            <Table
              head={[
                "Window",
                "Reviews",
                "Buy",
                "No buy",
                "Errors",
                "Avg latency",
                "Input tokens",
                "Output tokens",
              ]}
              rows={[
                ...a.reviews.map((r) => [
                  r.window,
                  n(r.reviews),
                  n(r.byDecision.buy ?? 0),
                  n(r.byDecision.no_buy ?? 0),
                  n(r.byDecision.error ?? 0),
                  ms(r.avgLatencyMs),
                  n(r.inputTokens),
                  n(r.outputTokens),
                ]),
                [
                  "replays 7d",
                  `${n(a.replays7d.runs)} runs`,
                  "",
                  "",
                  "",
                  `${n(a.replays7d.requests)} requests`,
                  n(a.replays7d.inputTokens),
                  n(a.replays7d.outputTokens),
                ],
              ]}
            />
            {hits.data && (
              <p className="small muted">
                Last 30 days: buys hit 2x {pct(hits.data.aiReviewer.buys.hitRate2xPct, 1)} of{" "}
                {hits.data.aiReviewer.buys.graded} graded, against{" "}
                {pct(hits.data.aiReviewer.allReviewed.hitRate2xPct, 1)} for everything it reviewed (lift{" "}
                {hits.data.aiReviewer.liftPts ?? "–"} pts). Brier {hits.data.aiReviewer.brier ?? "–"} vs the
                model's {hits.data.aiReviewer.curatorBrier ?? "–"} (lower is better).
              </p>
            )}
          </Panel>
          <Panel title="Recent reviews">
            <Table
              head={["When", "Token", "Mode", "Decision", "2x odds", "Latency", "Error"]}
              rows={a.recent.map((r) => [
                when(r.createdAt),
                r.symbol ?? shortAddress(r.mint),
                r.mode,
                r.decision ?? <Tag tone="bad">error</Tag>,
                r.probability2x === null ? "–" : `${Math.round(r.probability2x * 100)}%`,
                ms(r.latencyMs),
                r.error ? <span className="admin-error">{r.error}</span> : "–",
              ])}
            />
          </Panel>
        </div>
      )}
    </Load>
  );
}

// ---------- Database ----------

interface DbReport {
  activity: {
    pid: number;
    state: string | null;
    wait_event_type: string | null;
    wait_event: string | null;
    running_ms: number | null;
    query: string | null;
  }[];
  tables: {
    table: string;
    live_rows: number;
    dead_rows: number;
    total_mb: number;
    seq_scans: number;
    idx_scans: number | null;
    last_autovacuum: string | null;
  }[];
  locksWaiting: number;
}
interface StorageReport {
  databaseMb: number;
  tables: {
    table: string;
    liveRows: number;
    deadRows: number;
    heapMb: number;
    toastMb: number;
    indexMb: number;
    totalMb: number;
  }[];
  dailyRows: { day: string; table: string; rows: number }[];
  candidateOutcomesDaily: { day: string; kind: string; rows: number }[];
  tokens: { neverLive: number; liveNeverInBand: number; inBand: number; olderThan3d: number };
}

function Database() {
  const db = usePolling<DbReport>("/admin/db", 15_000);
  const storage = usePolling<StorageReport>("/admin/storage", 300_000);
  return (
    <div className="stack">
      <Panel
        title="Right now"
        note="Queries running on the database and the worker's hot tables. Refreshes every 15s."
      >
        <Load q={db}>
          {(d) => (
            <div className="stack">
              <p className="small muted">
                {d.activity.length} active connections · {d.locksWaiting} waiting on locks
              </p>
              <Table
                head={["PID", "State", "Waiting on", "Running", "Query"]}
                rows={d.activity.map((a) => [
                  a.pid,
                  a.state ?? "–",
                  a.wait_event ? `${a.wait_event_type}: ${a.wait_event}` : "–",
                  ms(a.running_ms),
                  <code className="admin-query">{a.query}</code>,
                ])}
                empty="Nothing running."
              />
              <Table
                head={["Hot table", "Rows", "Dead rows", "Size", "Seq scans", "Index scans", "Last vacuum"]}
                rows={d.tables.map((t) => [
                  t.table,
                  n(t.live_rows),
                  n(t.dead_rows),
                  `${n(t.total_mb)} MB`,
                  n(t.seq_scans),
                  n(t.idx_scans),
                  when(t.last_autovacuum),
                ])}
              />
            </div>
          )}
        </Load>
      </Panel>
      <Panel title="Storage" note="Where the disk goes, and new rows per day. Cached for 5 minutes.">
        <Load q={storage}>
          {(s) => {
            const days = [...new Set(s.dailyRows.map((r) => r.day))].sort();
            const kinds = [...new Set(s.candidateOutcomesDaily.map((r) => r.kind))].sort();
            const outcomeDays = [...new Set(s.candidateOutcomesDaily.map((r) => r.day))].sort();
            return (
              <div className="stack">
                <p className="small muted">
                  Database {(s.databaseMb / 1024).toFixed(2)} GB · tokens: {n(s.tokens.inBand)} reached the
                  mcap band, {n(s.tokens.liveNeverInBand)} traded but never in band, {n(s.tokens.neverLive)}{" "}
                  never traded, {n(s.tokens.olderThan3d)} older than 3 days.
                </p>
                <Table
                  head={["Table", "Rows", "Dead", "Heap MB", "TOAST MB", "Index MB", "Total MB"]}
                  rows={s.tables
                    .filter((t) => t.totalMb >= 0.1)
                    .map((t) => [
                      t.table,
                      n(t.liveRows),
                      n(t.deadRows),
                      t.heapMb,
                      t.toastMb,
                      t.indexMb,
                      <b>{t.totalMb}</b>,
                    ])}
                />
                <Table
                  head={["Day", "New tokens", "Model alerts"]}
                  rows={days.map((d) => [
                    new Date(d).toLocaleDateString(),
                    n(s.dailyRows.find((r) => r.day === d && r.table === "Token")?.rows ?? 0),
                    n(s.dailyRows.find((r) => r.day === d && r.table === "CuratedAlert")?.rows ?? 0),
                  ])}
                />
                <Table
                  head={["Day", ...kinds.map((k) => `${k} samples`)]}
                  rows={outcomeDays.map((d) => [
                    new Date(d).toLocaleDateString(),
                    ...kinds.map((k) =>
                      n(s.candidateOutcomesDaily.find((r) => r.day === d && r.kind === k)?.rows ?? 0),
                    ),
                  ])}
                />
              </div>
            );
          }}
        </Load>
      </Panel>
    </div>
  );
}

// ---------- API ----------

interface ApiReport {
  since: string | null;
  uptimeSeconds: number;
  memoryMb: number;
  stream: { connected: boolean; subscribers: number };
  routes: {
    route: string;
    count: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
    errorPct: number;
  }[];
  live: {
    viewedLast2Min: number;
    withLiveReading: number;
    readingAgeSeconds: { p50: number | null; p95: number | null; max: number | null };
    refresher: { callsLastMinute?: number; callsPerMinuteBudget?: number | null } | null;
  };
}

function ApiInstance() {
  const q = usePolling<ApiReport>("/admin/api", 30_000);
  return (
    <Load q={q}>
      {(a) => (
        <div className="stack">
          <div className="kpis">
            <Kpi
              label="Uptime"
              value={`${(a.uptimeSeconds / 3600).toFixed(1)}h`}
              sub={`${a.memoryMb} MB memory`}
            />
            <Kpi
              label="Push stream"
              value={a.stream.connected ? "Connected" : "Down"}
              sub={`${a.stream.subscribers} open dashboards`}
              tone={a.stream.connected ? "ok" : "warn"}
            />
            <Kpi
              label="Live price age"
              value={a.live.readingAgeSeconds.p50 === null ? "–" : `${a.live.readingAgeSeconds.p50}s`}
              sub={`p95 ${a.live.readingAgeSeconds.p95 ?? "–"}s · ${a.live.viewedLast2Min} tokens on screen`}
            />
            <Kpi
              label="Live refresher"
              value={n(a.live.refresher?.callsLastMinute)}
              sub={`calls last minute · budget ${a.live.refresher?.callsPerMinuteBudget ?? "–"}/min`}
            />
          </div>
          <Panel title="Route speed" note="This API instance since it started, slowest p95 first.">
            <Table
              head={["Route", "Calls", "p50", "p95", "p99", "Max", "5xx"]}
              rows={a.routes.map((r) => [
                <code>{r.route}</code>,
                n(r.count),
                ms(r.p50Ms),
                ms(r.p95Ms),
                ms(r.p99Ms),
                ms(r.maxMs),
                r.errorPct > 0 ? <Tag tone="bad">{pct(r.errorPct, 1)}</Tag> : "0%",
              ])}
            />
          </Panel>
        </div>
      )}
    </Load>
  );
}

// ---------- Config ----------

function Config() {
  const q = usePolling<Record<string, unknown>>("/admin/config", 300_000);
  return (
    <Panel
      title="Configuration"
      note="What this deployment is running with. Credentials show only whether they're set."
    >
      <Load q={q}>
        {(c) => {
          const { credentialsSet, adminWallets, ...rest } = c as {
            credentialsSet?: Record<string, boolean>;
            adminWallets?: string[];
          } & Record<string, unknown>;
          return (
            <div className="stack">
              {credentialsSet && (
                <Table
                  head={["Credential", "Set"]}
                  rows={Object.entries(credentialsSet).map(([k, v]) => [
                    k,
                    v ? <Tag tone="ok">set</Tag> : <Tag tone="warn">missing</Tag>,
                  ])}
                />
              )}
              {adminWallets && (
                <p className="small muted">
                  Admin wallets:{" "}
                  {adminWallets.map((w, i) => (
                    <span key={w}>
                      {i > 0 && ", "}
                      <Wallet address={w} />
                    </span>
                  ))}
                </p>
              )}
              <Table
                head={["Setting", "Value"]}
                rows={Object.entries(rest).map(([k, v]) => [
                  k,
                  <code>
                    {v === null ? "default" : typeof v === "object" ? JSON.stringify(v) : String(v)}
                  </code>,
                ])}
              />
            </div>
          );
        }}
      </Load>
    </Panel>
  );
}
