import { useState, type FormEvent } from "react";
import { ApiError, patch, post } from "../api";
import { usePolling } from "../hooks";
import { shortAddress } from "../format";
import { Kpi, Load, Panel, Table, Tag, dollars, ms, when } from "./adminShared";
import {
  describeFdsaPlan,
  fdsaRateText,
  fdsaSignedPct,
  fdsaSignedSol,
  fdsaSol,
  type FdsaPlan,
  type FdsaRate,
} from "./fdsaView";

/**
 * Admin > FDSA (owner decision 2026-10-31; moved here from the hidden #fdsa tab on 2026-11-01,
 * user ask): the AI desk that reviews every curated alert with Claude and paper-trades its picks
 * under its own adaptive exits - its controls, spend, reviews with their reasoning, plan history
 * and latency. Its API (apps/api/src/routes/fdsa.ts, /admin/fdsa) answers admins alone. The page
 * readers see at #fdsa is FdsaTab.tsx. Paper only: Live shows as not yet available.
 */

interface DeskConfig {
  buySol: number;
  maxOpenPositions: number;
  maxDailySpendSol: number;
  maxSignalAgeSeconds: number;
  slippageBps: number;
  reserveSol: number;
  dailyLossLimitSol?: number | null;
  [key: string]: unknown;
}

interface FdsaState {
  desk: {
    mode: string;
    modes: { id: string; available: boolean }[];
    running: boolean;
    pausedReason: string | null;
    config: DeskConfig;
    defaults: { config: DeskConfig; bankrollSol: number };
    bankrollLamports: string;
    cashLamports: string;
    openPositions: number;
    resetAt: string;
    lastRunAt: string | null;
    lastError: string | null;
    updatedBy: string | null;
    stats: {
      equityLamports: string;
      pnlLamports: string;
      pnlPct: number;
      entries: number;
      closed: number;
      wins: number;
    };
  };
  settings: {
    enabled: boolean | null;
    apiKeySet: boolean | null;
    screenModel: string;
    screenMinScore: number;
    decideModel: string;
    decideEffort: string;
    promptVersion: string;
  };
  budget: {
    capUsd: number;
    spentUsd: number;
    remainingUsd: number;
    exitReservePct: number;
    reviewsStopped: boolean;
    exitsStopped: boolean;
    resetsAt: string;
  };
  reviews: { today: ReviewCounts; last24h: ReviewCounts };
  worker: {
    scanAt: string | null;
    /** The scanner's FDSA heartbeat line (worker fdsa/review.ts fdsaHeartbeat); null before it reports. */
    fdsa: Record<string, string | number | boolean | null> | null;
  };
}

interface ReviewCounts {
  screened: number;
  shortlisted: number;
  shortlistRate: number | null;
  decided: number;
  trade: number;
  pass: number;
  revisions: number;
  failed: number;
  costUsd: number;
}

interface Revision {
  id: string;
  trigger: string;
  status: string;
  version: number;
  plan: FdsaPlan | null;
  multiple: number | null;
  reason: string | null;
  error: string | null;
  createdAt: string;
}

interface Position {
  id: string;
  mint: string;
  symbol: string | null;
  openedAt: string;
  closedAt: string | null;
  verdictLatencyMs: number | null;
  fillLatencyMs: number;
  holdMs: number;
  swapInLamports: string;
  pnlLamports: string;
  pnlPct: number | null;
  soldFraction: number;
  lastMultiple: number | null;
  peakMultiple: number | null;
  floorMultiple: number;
  planVersion: number;
  plan: FdsaPlan | null;
  closeRequested: boolean;
  closeReason: string | null;
  error: string | null;
  hit2x: boolean | null;
  ladderReturnPct: number | null;
  revisions: Revision[];
}

interface FdsaRecord {
  days: number;
  pool: FdsaRate;
  screen: { shortlisted: FdsaRate; dropped: FdsaRate; failed: FdsaRate };
  decide: { trade: FdsaRate; pass: FdsaRate; failed: FdsaRate };
  trades: FdsaRate;
  target: number;
  ladder: {
    summary: string;
    closedTrades: number;
    paired: number;
    fdsaAvgPct: number | null;
    ladderAvgPct: number | null;
    fdsaBetter: number;
  };
  latency: {
    trades: number;
    verdictP50Ms: number | null;
    fillP50Ms: number | null;
    fillP90Ms: number | null;
  };
}

interface Review {
  id: string;
  stage: string;
  model: string;
  answeredBy: string | null;
  decision: string | null;
  score: number | null;
  probability2x: number | null;
  conviction: number | null;
  reasoning: string | null;
  risks: string[];
  error: string | null;
  refused: boolean;
  costUsd: number | null;
  latencyMs: number;
  symbol: string | null;
  mint: string;
  hit2x: boolean | null;
  createdAt: string;
}

const numOrNull = (v: unknown) => (typeof v === "number" ? v : null);
const errorText = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));
const pct = (v: number | null) => (v === null ? "–" : `${Math.round(v * 100)}%`);
const multiple = (v: number | null | undefined) => (v === null || v === undefined ? "–" : `${v.toFixed(2)}x`);
const coin = (p: { symbol: string | null; mint: string }) => (
  <span title={p.mint}>{p.symbol ?? shortAddress(p.mint)}</span>
);
const grade = (hit: boolean | null) =>
  hit === null ? (
    <Tag tone="muted">grading</Tag>
  ) : hit ? (
    <Tag tone="ok">2x</Tag>
  ) : (
    <Tag tone="bad">no 2x</Tag>
  );

export function FdsaAdmin() {
  const state = usePolling<FdsaState>("/admin/fdsa", 15_000);
  return (
    <div className="stack fdsa">
      <Load q={state}>{(s) => <DeskPanel s={s} reload={state.reload} />}</Load>
      <PositionsPanel />
      <RecordPanel />
      <ReviewsPanel />
      <Load q={state}>{(s) => <LimitsPanel s={s} reload={state.reload} />}</Load>
    </div>
  );
}

function DeskPanel({ s, reload }: { s: FdsaState; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const d = s.desk;
  const t = s.reviews.today;

  const act = async (run: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await run();
      setMsg(done);
      reload();
    } catch (e) {
      setMsg(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const reset = () => {
    const raw = window.prompt(
      "Reset the paper bankroll to how many SOL? Positions and reviews stay in the record; the bankroll's P&L starts over.",
      String(Number(d.bankrollLamports) / 1e9 || d.defaults.bankrollSol),
    );
    if (raw === null) return;
    const bankrollSol = Number(raw);
    if (!Number.isFinite(bankrollSol) || bankrollSol <= 0) {
      setMsg("Enter a positive number of SOL.");
      return;
    }
    void act(() => post("/admin/fdsa/reset", { bankrollSol }), `Paper bankroll reset to ${bankrollSol} SOL.`);
  };

  const status = d.running ? (
    <Tag tone="ok">running</Tag>
  ) : d.pausedReason ? (
    <Tag tone="bad">stopped: {d.pausedReason}</Tag>
  ) : (
    <Tag tone="muted">paused</Tag>
  );
  const workerNote =
    s.settings.enabled === false
      ? "The scanner has FDSA_ENABLED off, so nothing is reviewed or traded whatever this says."
      : s.settings.enabled === null
        ? "The scanner hasn't reported whether FDSA_ENABLED is on yet."
        : s.settings.apiKeySet === false
          ? "The scanner has no ANTHROPIC_API_KEY, so FDSA makes no calls."
          : null;

  return (
    <Panel
      title="Desk"
      note="Claude screens every curated alert, decides on the shortlist, and paper-trades its picks under its own exit plan. The -50% stop is never loosened."
      actions={
        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <div className="segmented small" role="radiogroup" aria-label="Mode">
            {d.modes.map((m) => (
              <button
                key={m.id}
                role="radio"
                aria-checked={d.mode === m.id}
                className={d.mode === m.id ? "on" : ""}
                disabled={!m.available || busy}
                title={m.available ? undefined : "Not available yet: FDSA trades on paper only."}
                onClick={() => void act(() => patch("/admin/fdsa", { mode: m.id }), `Mode: ${m.id}.`)}
              >
                {m.id === "paper" ? "Paper" : "Live"}
                {!m.available && <span className="faint"> (soon)</span>}
              </button>
            ))}
          </div>
          {d.running ? (
            <button
              className="ghost"
              disabled={busy}
              onClick={() =>
                void act(
                  () => patch("/admin/fdsa", { running: false }),
                  "Paused. Open positions keep following their plans.",
                )
              }
            >
              Pause
            </button>
          ) : (
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                void act(
                  () => patch("/admin/fdsa", { running: true }),
                  "Resumed: reviewing alerts from now on.",
                )
              }
            >
              Resume
            </button>
          )}
          <button className="ghost" disabled={busy} onClick={reset}>
            Reset paper bankroll
          </button>
        </div>
      }
    >
      <p className="small">
        {status} <span className="muted">Paper mode. Last pass {when(d.lastRunAt)}.</span>
      </p>
      {workerNote && <p className="notice small">{workerNote}</p>}
      {d.lastError && <p className="error small">Last error: {d.lastError}</p>}
      {s.budget.reviewsStopped && (
        <p className="notice small">
          Today's review budget is spent: new alerts aren't reviewed until{" "}
          {new Date(s.budget.resetsAt).toLocaleTimeString()}.{" "}
          {s.budget.exitsStopped
            ? "Exit revisions have stopped too; open positions keep running their last plan."
            : "Exit revisions on open positions still have their reserve."}
        </p>
      )}
      {msg && <p className="small">{msg}</p>}
      <div className="kpis kpis-five">
        <Kpi
          label="Spend today"
          value={dollars(s.budget.spentUsd)}
          sub={`of ${dollars(s.budget.capUsd)}; ${s.budget.exitReservePct}% kept for exits`}
          tone={s.budget.reviewsStopped ? "warn" : undefined}
        />
        <Kpi
          label="Reviewed today"
          value={t.screened.toLocaleString()}
          sub={`${t.shortlisted} shortlisted (${pct(t.shortlistRate)}; aim ~10%)`}
        />
        <Kpi
          label="Trade / pass today"
          value={`${t.trade} / ${t.pass}`}
          sub={`${t.decided} decided, ${t.failed} failed calls`}
        />
        <Kpi
          label="Paper equity"
          value={fdsaSol(d.stats.equityLamports, 2)}
          sub={`${fdsaSignedSol(d.stats.pnlLamports)} (${fdsaSignedPct(d.stats.pnlPct)}) on ${fdsaSol(d.bankrollLamports, 0)}`}
          tone={Number(d.stats.pnlLamports) < 0 ? "warn" : "ok"}
        />
        <Kpi
          label="Open"
          value={`${d.openPositions} / ${d.config.maxOpenPositions}`}
          sub={`${fdsaSol(d.cashLamports, 2)} cash`}
        />
      </div>
      {s.worker.fdsa?.enabled === true && (
        <p className="muted small">
          Worker: {String(s.worker.fdsa.queued ?? 0)} queued, {String(s.worker.fdsa.inFlight ?? 0)} in flight;
          alert to verdict {ms(numOrNull(s.worker.fdsa.alertToVerdictP50Ms))} median
          {Number(s.worker.fdsa.staleTrades ?? 0) > 0 &&
            `; ${String(s.worker.fdsa.staleTrades)} trade verdicts landed after the alert went stale`}
          {typeof s.worker.fdsa.lastError === "string" && `; last error: ${s.worker.fdsa.lastError}`}.
          Reported {when(s.worker.scanAt)}.
        </p>
      )}
      <p className="muted small">
        Screen: {s.settings.screenModel}, shortlists at {s.settings.screenMinScore}. Decide:{" "}
        {s.settings.decideModel} at {s.settings.decideEffort} effort. Prompt {s.settings.promptVersion}.
      </p>
    </Panel>
  );
}

function PositionsPanel() {
  const q = usePolling<{ open: Position[]; closed: Position[] }>("/admin/fdsa/positions", 10_000);
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const close = async (p: Position) => {
    if (!window.confirm(`Sell ${p.symbol ?? p.mint} on the next paper pass?`)) return;
    try {
      await post(`/admin/fdsa/positions/${p.id}/close`, {});
      setMsg(`${p.symbol ?? "Position"} sells on the next pass.`);
      q.reload();
    } catch (e) {
      setMsg(errorText(e));
    }
  };
  return (
    <>
      <Panel
        title="Open positions"
        note="The plan each one runs now, the floor it enforces, and every plan it has had."
      >
        {msg && <p className="small">{msg}</p>}
        <Load q={q}>
          {(d) => (
            <div className="stack">
              <Table
                head={["Coin", "Now", "Peak", "Floor", "Sold", "Plan", "Held", "Latency", ""]}
                empty="No open positions."
                rows={d.open.map((p) => [
                  coin(p),
                  <span className="num">{multiple(p.lastMultiple)}</span>,
                  <span className="num">{multiple(p.peakMultiple)}</span>,
                  <span className="num" title="Everything still held sells at or under this multiple">
                    {multiple(p.floorMultiple)}
                  </span>,
                  <span className="num">{pct(p.soldFraction)}</span>,
                  <button className="ghost small" onClick={() => setOpen(open === p.id ? null : p.id)}>
                    v{p.planVersion} {open === p.id ? "▴" : "▾"}
                  </button>,
                  <span className="num">{ms(p.holdMs)}</span>,
                  <span className="num" title="alert to verdict / alert to fill">
                    {ms(p.verdictLatencyMs)} / {ms(p.fillLatencyMs)}
                  </span>,
                  p.closeRequested ? (
                    <Tag tone="warn">selling</Tag>
                  ) : (
                    <button className="ghost small" onClick={() => void close(p)}>
                      Sell
                    </button>
                  ),
                ])}
              />
              {d.open
                .filter((p) => p.id === open)
                .map((p) => (
                  <PlanHistory key={p.id} p={p} />
                ))}
            </div>
          )}
        </Load>
      </Panel>
      <Panel
        title="Closed trades"
        note="P&L is net of the paper fill penalty and fees. The ladder column is what the default ladder made on the same alert, from the alert price."
      >
        <Load q={q}>
          {(d) => (
            <Table
              head={["Coin", "P&L", "Exit", "Held", "Peak", "Goal", "Ladder", "Closed"]}
              empty="No closed trades yet."
              rows={d.closed.map((p) => [
                coin(p),
                <span className={`num ${Number(p.pnlLamports) >= 0 ? "good" : "bad"}`}>
                  {fdsaSignedSol(p.pnlLamports)} ({fdsaSignedPct(p.pnlPct)})
                </span>,
                p.closeReason ?? p.error ?? "–",
                <span className="num">{ms(p.holdMs)}</span>,
                <span className="num">{multiple(p.peakMultiple)}</span>,
                grade(p.hit2x),
                <span className="num">{fdsaSignedPct(p.ladderReturnPct)}</span>,
                when(p.closedAt),
              ])}
            />
          )}
        </Load>
      </Panel>
    </>
  );
}

function PlanHistory({ p }: { p: Position }) {
  return (
    <div className="panel fdsa-plan">
      <p className="small">
        <strong>{p.symbol ?? shortAddress(p.mint)}</strong>, plan v{p.planVersion}:{" "}
        {p.plan ? describeFdsaPlan(p.plan) : "unreadable; running the -50% stop and hold cap only"}
      </p>
      <Table
        head={["When", "Trigger", "At", "Result", "Plan", "Why"]}
        rows={p.revisions.map((r) => [
          when(r.createdAt),
          r.trigger,
          <span className="num">{multiple(r.multiple)}</span>,
          <Tag tone={r.status === "applied" ? "ok" : r.status === "kept" ? "muted" : "bad"}>
            {r.status} v{r.version}
          </Tag>,
          <span className="small">{r.plan ? describeFdsaPlan(r.plan) : "–"}</span>,
          <span className="small">{r.reason ?? r.error ?? "–"}</span>,
        ])}
      />
    </div>
  );
}

function RecordPanel() {
  const [days, setDays] = useState(30);
  const q = usePolling<FdsaRecord>(`/admin/fdsa/record?days=${days}`, 60_000);
  return (
    <Panel
      title="Record against the goal"
      note="A win is a clean 2x within 15 minutes of the alert, before the -50% stop - the same label every hit rate uses. The target is 75% on its buys; the pool's base rate is the bar to beat first."
      actions={
        <div className="segmented small" role="radiogroup" aria-label="Window">
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              role="radio"
              aria-checked={days === d}
              className={days === d ? "on" : ""}
              onClick={() => setDays(d)}
            >
              {d}d
            </button>
          ))}
        </div>
      }
    >
      <Load q={q}>
        {(r) => (
          <div className="stack">
            <Table
              head={["Group", "2x rate", "Graded / all", "4x"]}
              rows={[
                ["Its trades", r.trades],
                ['Its "trade" verdicts', r.decide.trade],
                ["Its passes", r.decide.pass],
                ["Shortlisted by the screen", r.screen.shortlisted],
                ["Dropped by the screen", r.screen.dropped],
                ["Pool: every alert screened", r.pool],
              ].map(([label, x]) => {
                const v = x as FdsaRate;
                return [
                  label as string,
                  <span className="num">{fdsaRateText(v)}</span>,
                  <span className="num">
                    {v.graded} / {v.total}
                  </span>,
                  <span className="num">{v.graded > 0 ? pct(v.wins4x / v.graded) : "–"}</span>,
                ];
              })}
            />
            <p className="muted small">
              {r.trades.graded < 30
                ? `Only ${r.trades.graded} graded trade${r.trades.graded === 1 ? "" : "s"} so far: too few to read a rate from.`
                : r.trades.rate !== null && r.trades.rate >= r.target
                  ? "At or above the 75% target on its trades."
                  : `Below the 75% target on its trades; the pool runs at ${fdsaRateText(r.pool)}.`}
            </p>
            <h3 className="small">Adaptive exits against the default ladder</h3>
            {r.ladder.paired === 0 ? (
              <p className="muted small">No closed trade has a graded ladder return to compare with yet.</p>
            ) : (
              <div className="kpis">
                <Kpi
                  label="FDSA's exits, avg"
                  value={fdsaSignedPct(r.ladder.fdsaAvgPct)}
                  sub={`${r.ladder.paired} paired trades`}
                />
                <Kpi
                  label="Default ladder, avg"
                  value={fdsaSignedPct(r.ladder.ladderAvgPct)}
                  sub={r.ladder.summary}
                />
                <Kpi
                  label="FDSA did better"
                  value={`${r.ladder.fdsaBetter} / ${r.ladder.paired}`}
                  tone={
                    r.ladder.fdsaAvgPct !== null && r.ladder.ladderAvgPct !== null
                      ? r.ladder.fdsaAvgPct >= r.ladder.ladderAvgPct
                        ? "ok"
                        : "warn"
                      : undefined
                  }
                />
              </div>
            )}
            <p className="muted small">
              FDSA's returns are net of the paper fill penalty and fees, from its own fill after the verdict.
              The ladder's are gross, from the alert price, so the comparison leans toward the ladder.
            </p>
            <p className="muted small">
              Latency over {r.latency.trades} trades: alert to verdict {ms(r.latency.verdictP50Ms)} median;
              alert to fill {ms(r.latency.fillP50Ms)} median, {ms(r.latency.fillP90Ms)} at p90.
            </p>
          </div>
        )}
      </Load>
    </Panel>
  );
}

function ReviewsPanel() {
  const [stage, setStage] = useState<"all" | "decide" | "screen" | "revise">("decide");
  const q = usePolling<Review[]>(`/admin/fdsa/reviews?stage=${stage}&limit=50`, 30_000);
  return (
    <Panel
      title="Recent reviews"
      note="Passes included. The reasoning is the model's own text, shown as text."
      actions={
        <div className="segmented small" role="radiogroup" aria-label="Stage">
          {(["decide", "screen", "revise", "all"] as const).map((s) => (
            <button
              key={s}
              role="radio"
              aria-checked={stage === s}
              className={stage === s ? "on" : ""}
              onClick={() => setStage(s)}
            >
              {s}
            </button>
          ))}
        </div>
      }
    >
      <Load q={q}>
        {(rows) => (
          <Table
            head={["When", "Coin", "Stage", "Verdict", "Odds", "Why", "Goal", "Cost"]}
            empty="No reviews yet."
            rows={rows.map((r) => [
              when(r.createdAt),
              coin(r),
              r.stage,
              r.decision === null ? (
                <Tag tone="bad">failed</Tag>
              ) : (
                <Tag tone={r.decision === "trade" || r.decision === "shortlist" ? "ok" : "muted"}>
                  {r.decision}
                </Tag>
              ),
              <span className="num">
                {r.stage === "screen" ? (r.score === null ? "–" : r.score.toFixed(2)) : pct(r.probability2x)}
              </span>,
              <span className="small fdsa-why">
                {r.reasoning ?? r.error ?? "–"}
                {r.risks.length > 0 && <span className="faint"> Risks: {r.risks.join("; ")}</span>}
                {r.refused && <span className="faint"> (refused)</span>}
              </span>,
              grade(r.hit2x),
              <span
                className="num"
                title={`${r.model}${r.answeredBy ? `, answered by ${r.answeredBy}` : ""}, ${ms(r.latencyMs)}`}
              >
                {dollars(r.costUsd)}
              </span>,
            ])}
          />
        )}
      </Load>
    </Panel>
  );
}

const LIMITS: { key: keyof DeskConfig; label: string; unit: string; step: string; note?: string }[] = [
  { key: "buySol", label: "SOL per trade", unit: "SOL", step: "0.01", note: "Fixed; the model never sizes." },
  { key: "maxOpenPositions", label: "Open positions at most", unit: "", step: "1" },
  { key: "maxDailySpendSol", label: "Entries per 24 h", unit: "SOL", step: "0.5" },
  { key: "maxSignalAgeSeconds", label: "Oldest alert it may buy", unit: "s", step: "1" },
  { key: "slippageBps", label: "Slippage", unit: "bps", step: "10" },
  { key: "reserveSol", label: "Reserve", unit: "SOL", step: "0.01" },
  { key: "dailyLossLimitSol", label: "Daily loss limit", unit: "SOL", step: "0.1", note: "0 means none." },
];

function LimitsPanel({ s, reload }: { s: FdsaState; reload: () => void }) {
  const [draft, setDraft] = useState<DeskConfig>(s.desk.config);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(s.desk.config);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await patch("/admin/fdsa", { config: draft });
      setMsg("Saved.");
      reload();
    } catch (err) {
      setMsg(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel
      title="Paper limits"
      note="The bot's own settings, with the owner's paper defaults: 0.5 SOL a trade, 6 open, 100 SOL a day, on a 10 SOL bankroll."
    >
      <form className="editor-form" onSubmit={(e) => void save(e)}>
        <div className="grid2">
          {LIMITS.map((f) => (
            <label className="field" key={f.key as string}>
              <span>
                {f.label}
                {f.unit && <span className="faint"> ({f.unit})</span>}
              </span>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step={f.step}
                value={String(draft[f.key] ?? "")}
                onChange={(e) =>
                  setDraft({ ...draft, [f.key]: e.target.value === "" ? "" : Number(e.target.value) })
                }
              />
              {f.note && <small className="faint">{f.note}</small>}
            </label>
          ))}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="primary" type="submit" disabled={busy || !dirty}>
            Save limits
          </button>
          <button
            className="ghost"
            type="button"
            disabled={busy}
            onClick={() => setDraft(s.desk.defaults.config)}
          >
            Defaults
          </button>
        </div>
        {msg && <p className="small">{msg}</p>}
      </form>
    </Panel>
  );
}
