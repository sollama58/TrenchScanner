import { useState, type ReactNode } from "react";
import type { Leaderboard, LearningCurve } from "../api";
import { usePolling } from "../hooks";
import { pct, shortAddress } from "../format";
import { ArrowRightIcon, BrainIcon, RadarIcon, RobotIcon, TargetIcon } from "../components/Icons";
import { Load, Panel, Table, Tag, n, when } from "./adminShared";
import { ModelUnderTheHood } from "./ModelTab";
import { Training } from "./AdminInsights";
import {
  ModelRecord,
  ModelsCompare,
  ModelsPerformance,
  ModelsStatus,
  type ModelsDesk,
} from "./AdminModelsTraining";
import { resolveSelection, type ExplainSeatRef } from "./adminModelsView";
import { ModelsExplorer } from "./AdminModelsExplorer";
import { niceScale, scaleTicks } from "../chartScale";
import { pickHandlers, pointerX, useChartWidth } from "../components/useChartWidth";

/**
 * The Admin "Models" section: how each seat makes its calls. One read (GET /admin/models/explain,
 * apps/api/src/modelExplain.ts) gives every seat's recipe, cutoff, call rate, what it leans on and
 * how it weighs its members; a seat's newest calls and one call's explanation load on demand.
 * Below them sits "Under the hood" (the leaderboard, scoring guides, exams, evolution, signals and
 * the AI reviewer), moved here from the public Models tab.
 */

type Role = "rules" | "learner" | "stacked" | "blend" | "agreement" | "topslice" | "narrative";

interface InputWeight {
  feature: string;
  label: string;
  sharePct: number;
  direction: 1 | -1 | null;
  onCalls: number | null;
}

interface MemberWeight {
  contestant: string;
  name: string;
  callsTopPct: number | null;
  weightPct: number | null;
  direction: 1 | -1 | null;
  backingPct: number | null;
}

interface Seat {
  id: string;
  name: string;
  role: Role;
  description: string;
  summary: string;
  isDefault: boolean;
  control: boolean;
  status: "calling" | "silent" | "untrained";
  model: { id: string; kind: string; trainedAt: string; trainingRows: number } | null;
  facts: { label: string; value: string }[];
  cutoff: {
    callsTopPct: number | null;
    fromExam: boolean;
    examWinRatePct: number | null;
    examCalls: number | null;
    meetsTargets: boolean | null;
    highTopPct: number | null;
    sampleCallsPct: number | null;
  };
  calls: { lastHour: number; last24h: number; last7d: number; perHour24h: number; lastAt: string | null };
  calibration: { knots: { rank: number; rate: number; n: number }[]; calls: number } | null;
  agreementCurve: { agreeing: number; rows: number; winRatePct: number | null }[] | null;
  inputs: InputWeight[] | null;
  inputSample: { rows: number; calls: number } | null;
  members: MemberWeight[] | null;
  otherSignals: { label: string; weightPct: number; direction: 1 | -1 }[] | null;
  rule: string | null;
  rules: { source: string; lines: string[]; reason: string; teacherName: string | null } | null;
}

interface Lineup {
  builtAt: string;
  defaultModel: string;
  aiReviewMode: string;
  momentsPerHour: number;
  sample: { rows: number; from: string | null; to: string | null; deepReadRows: number };
  seats: Seat[];
}

interface SeatCall {
  id: string;
  createdAt: string;
  confidence: number;
  tier: string | null;
  calibratedPct: number | null;
  reasons: string[];
  symbol: string | null;
  mint: string;
  result: "open" | "stopped" | "4x" | "2x" | "miss";
}

interface CallPush {
  label: string;
  value: number;
}

interface CallExplain {
  alert: {
    id: string;
    confidence: number;
    tier: string | null;
    calibratedPct: number | null;
    reasons: string[];
  };
  recomputed: boolean;
  note: string | null;
  score: number | null;
  cutoff: number | null;
  pushesFor: CallPush[];
  pushesAgainst: CallPush[];
  members:
    | {
        contestant: string;
        name: string;
        probability: number | null;
        rank: number | null;
        callRank: number | null;
        calling: boolean;
      }[]
    | null;
  strongestMember: string | null;
}

const COMBINERS: readonly Role[] = ["stacked", "blend", "agreement", "topslice"];

const ROLE_TEXT: Record<Role, string> = {
  rules: "Rules",
  learner: "Learner",
  narrative: "Narrative",
  stacked: "Combiner",
  blend: "Combiner",
  agreement: "Combiner",
  topslice: "Combiner",
};

/** "top 1.6%" for a share of decision moments. */
function topShare(v: number | null | undefined): string {
  if (v === null || v === undefined) return "–";
  return `top ${v >= 10 ? v.toFixed(0) : v.toFixed(1)}%`;
}

/** A 0-1 rank as the share of moments above it: "top 3.5%", "top <0.1%". */
function rankText(rank: number): string {
  const share = (1 - rank) * 100;
  return share < 0.1 ? "top <0.1%" : `top ${share.toFixed(1)}%`;
}

const perHour = (v: number) => (v >= 10 ? v.toFixed(0) : v.toFixed(1));

const LEARNING_PATH = "/curated/insights/learning?days=30&tz=America%2FNew_York";

function jump(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function ModelsAdmin() {
  const q = usePolling<Lineup>("/admin/models/explain", 300_000);
  const desk = usePolling<ModelsDesk>("/admin/models/desk", 15_000);
  const board = usePolling<Leaderboard>("/curated/models?days=7", 120_000);
  const learning = usePolling<LearningCurve>(LEARNING_PATH, 300_000);
  const [picked, setPicked] = useState<string | null>(null);
  const explainSeats: ExplainSeatRef[] = (q.data?.seats ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    status: s.status,
    callsPerHour: s.calls.perHour24h,
  }));
  const selected = resolveSelection(
    picked,
    q.data?.seats ?? [],
    desk.data?.roster ?? [],
    q.data?.defaultModel ?? null,
  );
  const seat = q.data?.seats.find((s) => s.id === selected) ?? null;
  const rosterSeat = desk.data?.roster.find((r) => r.id === selected) ?? null;
  const active = desk.data?.active.find((m) => m.contestant === selected) ?? null;
  const entry = board.data?.entries.find((e) => e.id === selected) ?? null;
  const record = (
    <ModelRecord
      name={seat?.name ?? rosterSeat?.name ?? selected ?? "Model"}
      enabled={rosterSeat?.enabled ?? seat !== null}
      retired={rosterSeat?.retired ?? false}
      status={seat?.status ?? entry?.status ?? null}
      kind={active?.kind ?? seat?.model?.kind ?? null}
      modelId={active?.id ?? seat?.model?.id ?? null}
      trainedAt={active?.createdAt ?? seat?.model?.trainedAt ?? null}
      trainingRows={active?.trainingRows ?? seat?.model?.trainingRows ?? null}
      trainingFrom={active?.trainingFrom ?? null}
      trainingTo={active?.trainingTo ?? null}
      exam={active?.exam ?? null}
      entry={entry}
      labelSummary={
        active || seat?.model
          ? "The label rule is not stored on this model row. The trainer spec above is what the fit loads."
          : null
      }
    />
  );
  return (
    <div className="stack">
      <nav className="models-jump" aria-label="On this page">
        {(
          [
            ["models-status", "Trainer"],
            ["models-compare", "Comparison"],
            ["models-roster", "Lineup"],
            ["models-seat", "This model"],
            ["models-performance", "Over time"],
            ["models-explorer", "Explorer"],
            ["models-runs", "Runs"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" className="ghost" onClick={() => jump(id)}>
            {label}
          </button>
        ))}
      </nav>
      <div id="models-status">
        <ModelsStatus q={desk} />
      </div>
      <div id="models-compare">
        <ModelsCompare
          roster={desk.data?.roster ?? []}
          explain={explainSeats}
          board={board}
          selected={selected}
          onPick={setPicked}
        />
      </div>
      <div id="models-roster">
        <Load q={q}>
          {(data) => (
            <div className="stack">
              <Lineup data={data} selected={seat?.id ?? null} onPick={setPicked} />
              {seat ? (
                <SeatPanel seat={seat} data={data} onPick={setPicked} record={record} />
              ) : (
                rosterSeat && (
                  <Panel
                    title={rosterSeat.name}
                    note={
                      rosterSeat.retired
                        ? "Retired seat."
                        : rosterSeat.enabled
                          ? "Enabled, but this response has no recipe for it yet."
                          : "Not on the enabled roster. The trainer does not fit it."
                    }
                  >
                    {record}
                  </Panel>
                )
              )}
              {seat && <CallsPanel key={seat.id} seat={seat} />}
            </div>
          )}
        </Load>
      </div>
      <div id="models-performance">
        <ModelsPerformance
          q={learning}
          modelId={selected}
          modelName={seat?.name ?? rosterSeat?.name ?? null}
        />
      </div>
      <div id="models-explorer">
        <ModelsExplorer seats={explainSeats} />
      </div>
      <div className="stack" id="models-runs">
        {desk.data && <p className="muted small">{desk.data.runHistoryNote}</p>}
        <Training />
      </div>
      <ModelUnderTheHood />
    </div>
  );
}

// ---------- The lineup ----------

function Lineup({
  data,
  selected,
  onPick,
}: {
  data: Lineup;
  selected: string | null;
  onPick: (id: string) => void;
}) {
  const learners = data.seats.filter((s) => s.role === "learner" || s.role === "narrative");
  const combiners = data.seats.filter((s) => COMBINERS.includes(s.role));
  const def = data.seats.find((s) => s.id === data.defaultModel);
  const learnerCalls = learners.reduce((sum, s) => sum + s.calls.perHour24h, 0);
  const combinerCalls = combiners.reduce((sum, s) => sum + s.calls.perHour24h, 0);
  return (
    <Panel
      title="How the models decide"
      note={
        <>
          Every seat's recipe, cutoff and alert rate, read from what training stored. Inputs are averaged over
          the {n(data.sample.rows)} newest decision moments ({when(data.sample.from)} to{" "}
          {when(data.sample.to)}). Built {when(data.builtAt)}; pick a model to see inside it.
        </>
      }
    >
      <ol className="pipeline model-flow" aria-label="How an alert is made">
        <FlowStage
          Icon={RadarIcon}
          title="Scanner"
          value={perHour(data.momentsPerHour)}
          caption="decision moments / hour"
        />
        <FlowStage
          Icon={BrainIcon}
          title={`${learners.length} learners`}
          value={perHour(learnerCalls)}
          caption="alerts / hour between them"
        />
        <FlowStage
          Icon={BrainIcon}
          title={`${combiners.length} combiners`}
          value={perHour(combinerCalls)}
          caption={`alerts / hour: ${combiners.map((c) => c.name).join(", ")}`}
        />
        <FlowStage
          Icon={TargetIcon}
          title={`Default feed: ${def?.name ?? data.defaultModel}`}
          value={def ? perHour(def.calls.perHour24h) : "–"}
          caption="alerts / hour"
        />
        <li className="stage">
          <span className="stage-icon">
            <RobotIcon size={16} />
          </span>
          <span className="stage-title">AI review</span>
          <span className="stage-rate">{data.aiReviewMode}</span>
          <span className="stage-caption">
            {data.aiReviewMode === "gate"
              ? "decides what sends"
              : data.aiReviewMode === "shadow"
                ? "grades, sends nothing"
                : "not running"}
          </span>
        </li>
      </ol>
      <p className="faint small">
        Alerts per hour over the last 24 hours. Each seat alerts on its own ledger.
      </p>
      <div className="table-wrap">
        <table className="model-lineup">
          <thead>
            <tr>
              <th>Model</th>
              <th>Kind</th>
              <th
                className="r"
                title="The share of decision moments its cutoff alerts on: as its exam set it, or (≈) the share of recent moments it clears, for a seat whose cutoff is a score"
              >
                Cutoff
              </th>
              <th className="r" title="Its exam's 2x rate at that cutoff">
                Exam 2x
              </th>
              <th className="r">Alerts / h</th>
              <th className="r">7d alerts</th>
              <th>Last alert</th>
              <th>Leans on most</th>
            </tr>
          </thead>
          <tbody>
            {data.seats.map((s) => (
              <tr
                key={s.id}
                className={s.id === selected ? "selected" : ""}
                onClick={() => onPick(s.id)}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onPick(s.id);
                  }
                }}
                aria-selected={s.id === selected}
              >
                <td>
                  <span className="model-name">{s.name}</span>
                  {s.isDefault && <Tag tone="ok">default</Tag>}
                  {s.control && <Tag tone="muted">control</Tag>}
                  {s.status !== "calling" && <Tag tone="warn">{s.status}</Tag>}
                </td>
                <td className="muted">{ROLE_TEXT[s.role]}</td>
                <td className="r num">
                  {s.cutoff.fromExam || s.cutoff.callsTopPct === null ? "" : "≈ "}
                  {topShare(s.cutoff.callsTopPct)}
                </td>
                <td className="r num">{pct(s.cutoff.examWinRatePct, 0)}</td>
                <td className="r num">{s.calls.perHour24h.toFixed(1)}</td>
                <td className="r num">{n(s.calls.last7d)}</td>
                <td>{when(s.calls.lastAt)}</td>
                <td className="muted">{leansOn(s)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function leansOn(s: Seat): string {
  if (s.inputs && s.inputs[0]) return s.inputs[0].label;
  if (s.members && s.members.length > 0) {
    const key = (m: MemberWeight) => m.weightPct ?? m.backingPct ?? -1;
    const top = [...s.members].sort((a, b) => key(b) - key(a))[0]!;
    return key(top) >= 0 ? top.name : `${s.members.length} members`;
  }
  if (s.rules) return s.rules.source === "learned" ? "a learned points table" : "hand-tuned checks";
  return "–";
}

function FlowStage({
  Icon,
  title,
  value,
  caption,
}: {
  Icon: typeof RadarIcon;
  title: string;
  value: string;
  caption: string;
}) {
  return (
    <li className="stage">
      <span className="stage-icon">
        <Icon size={16} />
      </span>
      <span className="stage-title">{title}</span>
      <span className="stage-rate num">{value}</span>
      <span className="stage-caption">{caption}</span>
      <ArrowRightIcon size={16} className="stage-arrow" />
    </li>
  );
}

// ---------- One seat ----------

function SeatPanel({
  seat,
  data,
  onPick,
  record,
}: {
  seat: Seat;
  data: Lineup;
  onPick: (id: string) => void;
  record?: ReactNode;
}) {
  const combiner = COMBINERS.includes(seat.role);
  return (
    <Panel
      title={seat.name}
      note={seat.summary}
      actions={
        <select aria-label="Model" value={seat.id} onChange={(e) => onPick(e.target.value)}>
          {data.seats.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      }
    >
      <div className="stack">
        {record}
        <div className="model-facts">
          {seat.model && (
            <div>
              <span className="eyebrow">Trained</span>
              <span>
                {when(seat.model.trainedAt)} on {n(seat.model.trainingRows)} rows
              </span>
            </div>
          )}
          {seat.facts.map((f) => (
            <div key={f.label}>
              <span className="eyebrow">{f.label}</span>
              <span>{f.value}</span>
            </div>
          ))}
        </div>

        <CutoffView seat={seat} />

        {seat.inputs && seat.inputs.length > 0 && <InputsView seat={seat} sample={data.sample} />}
        {combiner && seat.members && <MembersView seat={seat} />}
        {seat.agreementCurve && seat.agreementCurve.length > 0 && <AgreementView seat={seat} />}
        {seat.rules && (
          <div>
            <h3>The checks it runs</h3>
            <p className="muted small">
              {seat.rules.source === "learned"
                ? `A points table learned from ${seat.rules.teacherName ?? "the best model"}. `
                : "Hand-tuned checks on the scanner's score. "}
              {seat.rules.reason}
            </p>
            <ul className="model-rules">
              {seat.rules.lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </div>
        )}
        {!seat.model && (
          <p className="empty">No trained model yet: it appears after its first training run.</p>
        )}
      </div>
    </Panel>
  );
}

function CutoffView({ seat }: { seat: Seat }) {
  const c = seat.cutoff;
  return (
    <div>
      <h3>Where it draws the line</h3>
      <div className="model-kpis">
        <Stat
          label="Alerts"
          value={topShare(c.callsTopPct)}
          sub={
            c.callsTopPct === null
              ? "no cutoff yet"
              : c.fromExam
                ? "of decision moments, set by its exam"
                : "of recent moments (its cutoff is a score)"
          }
        />
        <Stat
          label="Exam 2x at cutoff"
          value={pct(c.examWinRatePct, 1)}
          sub={
            c.examCalls !== null
              ? `${n(c.examCalls)} exam alerts${c.meetsTargets ? ", meets targets" : ", best effort"}`
              : undefined
          }
        />
        <Stat
          label="Alerts / hour"
          value={seat.calls.perHour24h.toFixed(1)}
          sub={`${n(seat.calls.last24h)} in 24h · ${n(seat.calls.lastHour)} last hour`}
        />
        <Stat
          label="Recent moments it clears"
          value={pct(c.sampleCallsPct, 1)}
          sub={
            seat.inputSample
              ? `${n(seat.inputSample.calls)} of ${n(seat.inputSample.rows)}`
              : "not replayable"
          }
        />
      </div>
      {c.callsTopPct !== null && <CutoffStrip calls={c.callsTopPct} high={c.highTopPct} />}
      {seat.calibration && seat.calibration.knots.length > 0 && (
        <CalibrationChart calibration={seat.calibration} cutoff={c.callsTopPct} high={c.highTopPct} />
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="model-stat">
      <span className="eyebrow">{label}</span>
      <span className="num model-stat-value">{value}</span>
      {sub && <span className="faint small">{sub}</span>}
    </div>
  );
}

/**
 * Every decision moment as one strip, lowest-ranked to highest: the call zone and the
 * high-conviction zone at the right end. A log scale would hide how small the zone is; the inset
 * shows the top 10% blown up.
 */
function CutoffStrip({ calls, high }: { calls: number; high: number | null }) {
  const zoom = Math.max(10, calls * 1.5);
  const at = (share: number) => `${Math.max(0.8, (share / zoom) * 100)}%`;
  return (
    <div className="cutoff-strip" aria-label={`Alerts on the top ${calls}% of decision moments`}>
      <div className="cutoff-row">
        <span className="faint small">All moments</span>
        <span className="cutoff-track">
          <span className="cutoff-zone" style={{ width: `${Math.max(0.6, calls)}%` }} />
        </span>
      </div>
      <div className="cutoff-row">
        <span className="faint small">Top {zoom.toFixed(0)}%</span>
        <span className="cutoff-track">
          <span className="cutoff-zone" style={{ width: at(calls) }} />
          {high !== null && <span className="cutoff-high" style={{ width: at(high) }} />}
        </span>
      </div>
      <div className="model-legend small">
        <span>
          <i className="legend-dot cutoff-zone" /> alerts ({topShare(calls)})
        </span>
        {high !== null && (
          <span>
            <i className="legend-dot cutoff-high" /> high conviction ({topShare(high)})
          </span>
        )}
      </div>
    </div>
  );
}

/** The calibration table: 2x rate of recent out-of-sample calls by rank, over the top of the ranking. */
function CalibrationChart({
  calibration,
  cutoff,
  high,
}: {
  calibration: NonNullable<Seat["calibration"]>;
  cutoff: number | null;
  high: number | null;
}) {
  const [hover, setHover] = useState<number | null>(null);
  // Drawn at the box's real width, so its 12px text stays 12px on a phone instead of shrinking
  // with a fixed viewBox.
  const [boxRef, W] = useChartWidth();
  const H = 180;
  const pad = { l: 40, r: 12, t: 12, b: 26 };
  const knots = calibration.knots;
  const cutRank = cutoff !== null ? 1 - cutoff / 100 : null;
  // The top of the ranking is where calls live: show from a little under the cutoff (at most the
  // top 20%), not the whole range, where the long flat bottom would squeeze it to a sliver.
  const lo = Math.min(Math.max(0, Math.min(0.8, cutRank !== null ? cutRank - 0.05 : 0.8)), 0.95);
  // Round ticks (10%, 20%, 30%), not halves of the data's top (9%, 18%).
  const scale = niceScale(
    0,
    Math.max(0.1, ...knots.filter((k, i) => (knots[i + 1]?.rank ?? 1) > lo).map((k) => k.rate)) * 1.1 * 100,
    3,
  );
  const top = scale.max / 100;
  const x = (r: number) => pad.l + ((r - lo) / (1 - lo)) * (W - pad.l - pad.r);
  const y = (v: number) => H - pad.b - (v / top) * (H - pad.t - pad.b);
  const visible = knots.filter((k, i) => (knots[i + 1]?.rank ?? 1) > lo);
  let path = "";
  visible.forEach((k, i) => {
    const x0 = x(Math.max(lo, k.rank));
    const x1 = x(visible[i + 1]?.rank ?? 1);
    path += `${i === 0 ? "M" : "L"}${x0},${y(k.rate)} L${x1},${y(k.rate)} `;
  });
  const ticks = scaleTicks(scale).map((v) => v / 100);
  const shown = hover !== null ? visible[hover] : null;
  // The step under the pointer, on a move or a tap.
  const pick = pickHandlers((e) => {
    const r = lo + ((pointerX(e, W) - pad.l) / (W - pad.l - pad.r)) * (1 - lo);
    if (r < lo || r > 1) return null;
    const i = visible.findIndex((k, j) => r < (visible[j + 1]?.rank ?? 1.0001) && r >= Math.max(lo, k.rank));
    return i < 0 ? null : i;
  }, setHover);
  return (
    <div className="model-chart">
      <h3>What an alert's rank means</h3>
      <p className="muted small">
        The card's calibrated %: how often recent out-of-sample alerts at each rank doubled (
        {n(calibration.calls)} alerts). The dashed lines are its cutoff and high-conviction tier.
      </p>
      <div ref={boxRef}>
        <svg viewBox={`0 0 ${W} ${H}`} height={H} role="img" aria-label="2x rate by rank" {...pick}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="chart-grid" />
              <text x={pad.l - 6} y={y(t) + 4} className="chart-tick" textAnchor="end">
                {Number((t * 100).toFixed(1))}%
              </text>
            </g>
          ))}
          {[lo, (lo + 1) / 2, 1].map((r, i) => (
            <text
              key={r}
              x={x(r)}
              y={H - 8}
              className="chart-tick"
              textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}
            >
              {r === 1 ? "top" : `top ${((1 - r) * 100).toFixed((1 - r) * 100 >= 10 ? 0 : 1)}%`}
            </text>
          ))}
          {cutRank !== null && cutRank >= lo && (
            <line x1={x(cutRank)} x2={x(cutRank)} y1={pad.t} y2={H - pad.b} className="chart-mark" />
          )}
          {high !== null && 1 - high / 100 >= lo && (
            <line
              x1={x(1 - high / 100)}
              x2={x(1 - high / 100)}
              y1={pad.t}
              y2={H - pad.b}
              className="chart-mark alt"
            />
          )}
          <path d={path} className="chart-line" />
          {visible.map((k, i) => {
            const x0 = x(Math.max(lo, k.rank));
            const x1 = x(visible[i + 1]?.rank ?? 1);
            return (
              <rect
                key={k.rank}
                x={x0}
                y={pad.t}
                width={Math.max(1, x1 - x0)}
                height={H - pad.t - pad.b}
                className={`chart-hit${hover === i ? " on" : ""}`}
              />
            );
          })}
        </svg>
      </div>
      <p className="faint small model-readout">
        {shown
          ? `From the top ${((1 - shown.rank) * 100).toFixed(1)}%: ${pct(shown.rate * 100, 1)} doubled (${n(shown.n)} alerts in this step)`
          : "Hover or tap a step for its rate."}
      </p>
    </div>
  );
}

function InputsView({ seat, sample }: { seat: Seat; sample: Lineup["sample"] }) {
  const inputs = seat.inputs!;
  const maxShare = Math.max(1, ...inputs.map((i) => i.sharePct));
  const maxPush = Math.max(0.01, ...inputs.map((i) => Math.abs(i.onCalls ?? 0)));
  const narrative = seat.role === "narrative";
  return (
    <div>
      <h3>What it leans on</h3>
      <p className="muted small">
        Each input's share of how much it moved the score, averaged over{" "}
        {narrative
          ? `the ${n(sample.deepReadRows)} recent moments with TokenSage's deep read`
          : "recent decision moments"}
        . The right column is its average push on the {n(seat.inputSample?.calls ?? 0)} of them it would have
        alerted on: blue pushed toward the alert, orange against.{" "}
        {seat.inputs!.some((i) => i.direction !== null) ? "▲ more is better, ▼ less is better." : ""}
      </p>
      <div className="input-bars" role="table">
        <div className="input-row input-head" role="row">
          <span role="columnheader">Input</span>
          <span role="columnheader">Share of influence</span>
          <span role="columnheader" className="r">
            On its alerts
          </span>
        </div>
        {inputs.map((i) => (
          <div className="input-row" role="row" key={i.label}>
            <span className="input-label" role="cell" title={i.feature}>
              {i.direction === 1 ? "▲ " : i.direction === -1 ? "▼ " : ""}
              {i.label}
            </span>
            <span className="input-share" role="cell">
              <span className="hbar-track">
                <span
                  className="hbar-fill"
                  style={{ width: `${Math.max(1, (i.sharePct / maxShare) * 100)}%` }}
                />
              </span>
              <span className="num small">{i.sharePct.toFixed(1)}%</span>
            </span>
            <span
              className="input-push"
              role="cell"
              title="Average push on the log-odds of a 2x, on its alerts"
            >
              {i.onCalls === null ? (
                <span className="faint small">–</span>
              ) : (
                <span className="diverge">
                  <span className="diverge-half neg">
                    {i.onCalls < 0 && (
                      <span
                        className="diverge-fill neg"
                        style={{ width: `${(Math.abs(i.onCalls) / maxPush) * 100}%` }}
                      />
                    )}
                  </span>
                  <span className="diverge-half pos">
                    {i.onCalls > 0 && (
                      <span
                        className="diverge-fill pos"
                        style={{ width: `${(i.onCalls / maxPush) * 100}%` }}
                      />
                    )}
                  </span>
                </span>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MembersView({ seat }: { seat: Seat }) {
  const members = seat.members!;
  const consensus = seat.role === "stacked";
  const bars = consensus ? members.map((m) => m.weightPct ?? 0) : members.map((m) => m.backingPct ?? 0);
  const max = Math.max(1, ...bars);
  return (
    <div>
      <h3>How it weighs its members</h3>
      <p className="muted small">
        {seat.rule}{" "}
        {consensus
          ? "Bars are the meta model's share of weight on each member's rank."
          : members.some((m) => m.backingPct !== null)
            ? "Bars are how often each member was alerting too, on the recent moments it would have alerted on."
            : ""}
      </p>
      <div className="input-bars" role="table">
        <div className="input-row input-head" role="row">
          <span role="columnheader">Member</span>
          <span role="columnheader">{consensus ? "Weight" : "Alerting too on its alerts"}</span>
          <span role="columnheader" className="r">
            Member cutoff
          </span>
        </div>
        {members.map((m, i) => (
          <div className="input-row" role="row" key={m.contestant}>
            <span className="input-label" role="cell">
              {m.direction === -1 ? "▼ " : ""}
              {m.name}
            </span>
            <span className="input-share" role="cell">
              <span className="hbar-track">
                <span className="hbar-fill" style={{ width: `${Math.max(1, (bars[i]! / max) * 100)}%` }} />
              </span>
              <span className="num small">{pct(consensus ? m.weightPct : m.backingPct, 0)}</span>
            </span>
            <span className="num small r" role="cell">
              {topShare(m.callsTopPct)}
            </span>
          </div>
        ))}
      </div>
      {seat.otherSignals && seat.otherSignals.length > 0 && (
        <p className="faint small">
          Also weighs:{" "}
          {seat.otherSignals
            .map((o) => `${o.label} ${o.weightPct.toFixed(0)}%${o.direction === -1 ? " (against)" : ""}`)
            .join(" · ")}
        </p>
      )}
    </div>
  );
}

/** Agreement's exam: 2x rate by how many members called. */
function AgreementView({ seat }: { seat: Seat }) {
  const curve = seat.agreementCurve!.filter((p) => p.rows > 0);
  const need = seat.rule ? Number(/at least (\d+)/.exec(seat.rule)?.[1] ?? NaN) : NaN;
  const max = Math.max(10, ...curve.map((p) => p.winRatePct ?? 0));
  return (
    <div>
      <h3>Does agreement pay?</h3>
      <p className="muted small">
        Its exam: how often coins doubled by how many members alerted on them. Darker bars are where it
        alerts.
      </p>
      <div className="agree-chart" role="table">
        {curve.map((p) => (
          <div
            key={p.agreeing}
            className={`agree-col${p.agreeing >= need ? " on" : ""}`}
            role="row"
            title={`${p.agreeing} alerting: ${pct(p.winRatePct, 1)} of ${n(p.rows)} moments doubled`}
          >
            <span className="num small">{pct(p.winRatePct, 0)}</span>
            {/* No rate is no bar (the label above says "–"), not a sliver that reads as near 0%. */}
            {p.winRatePct !== null && (
              <span className="agree-bar" style={{ height: `${Math.max(2, (p.winRatePct / max) * 100)}%` }} />
            )}
            <span className="small">{p.agreeing}</span>
            <span className="faint agree-n">{n(p.rows)}</span>
          </div>
        ))}
      </div>
      <p className="faint small">Members alerting (bottom) and the moments behind each bar.</p>
    </div>
  );
}

// ---------- Its calls, and why ----------

function resultTag(r: SeatCall["result"]) {
  if (r === "2x" || r === "4x") return <Tag tone="ok">{r}</Tag>;
  if (r === "miss") return <Tag tone="bad">miss</Tag>;
  if (r === "stopped") return <Tag tone="muted">stopped</Tag>;
  return <Tag tone="muted">open</Tag>;
}

function CallsPanel({ seat }: { seat: Seat }) {
  const q = usePolling<SeatCall[]>(`/admin/models/${seat.id}/calls?limit=12`, 120_000);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Panel
      title={`Why ${seat.name} alerted`}
      note="Its newest alerts with the reasons recorded when they sent. Explain runs the alert's stored inputs back through the exact model that made it."
    >
      <Load q={q}>
        {(calls) =>
          calls.length === 0 ? (
            <p className="muted small">No alerts yet.</p>
          ) : (
            <ul className="seat-calls">
              {calls.map((c) => (
                <li key={c.id}>
                  <div className="seat-call-head">
                    <a
                      href={`https://dexscreener.com/solana/${c.mint}`}
                      target="_blank"
                      rel="noreferrer"
                      title={c.mint}
                    >
                      {c.symbol ?? shortAddress(c.mint)}
                    </a>
                    {when(c.createdAt)}
                    <span className="num small">conf {Math.round(c.confidence)}</span>
                    {c.calibratedPct !== null && (
                      <span className="num small">calibrated {pct(c.calibratedPct, 0)}</span>
                    )}
                    {c.tier === "high" && <Tag tone="warn">high</Tag>}
                    {resultTag(c.result)}
                    <button
                      className="ghost model-explain-btn"
                      onClick={() => setOpen(open === c.id ? null : c.id)}
                    >
                      {open === c.id ? "Hide" : "Explain"}
                    </button>
                  </div>
                  {c.reasons.length > 0 && <p className="muted small">{c.reasons.join(" · ")}</p>}
                  {open === c.id && <CallExplainView id={c.id} />}
                </li>
              ))}
            </ul>
          )
        }
      </Load>
    </Panel>
  );
}

function CallExplainView({ id }: { id: string }) {
  const q = usePolling<CallExplain>(`/admin/models/calls/${id}`, 3_600_000);
  return (
    <div className="call-explain">
      <Load q={q}>
        {(x) => {
          const max = Math.max(0.01, ...[...x.pushesFor, ...x.pushesAgainst].map((p) => Math.abs(p.value)));
          return (
            <div className="stack">
              {x.score !== null && (
                <p className="small">
                  Score <b className="num">{x.score.toFixed(1)}</b> against a cutoff of{" "}
                  <b className="num">{x.cutoff?.toFixed(1) ?? "–"}</b>
                  {x.alert.calibratedPct !== null && (
                    <> · the card showed {pct(x.alert.calibratedPct, 0)} calibrated</>
                  )}
                </p>
              )}
              {x.note && <p className="muted small">{x.note}</p>}
              {x.members && (
                <Table
                  head={["Member", "Rank", "Cutoff", "Alerting"]}
                  rows={x.members.map((m) => [
                    m.name,
                    <span className="num">{m.rank !== null ? rankText(m.rank) : "–"}</span>,
                    <span className="num">{m.callRank !== null ? rankText(m.callRank) : "none"}</span>,
                    m.calling ? <Tag tone="ok">yes</Tag> : <span className="faint">no</span>,
                  ])}
                />
              )}
              {(x.pushesFor.length > 0 || x.pushesAgainst.length > 0) && (
                <div>
                  <p className="muted small">
                    {x.strongestMember ? `What ${x.strongestMember}, its strongest member, saw. ` : ""}Inputs
                    that pushed the score up (blue) and down (orange), in log-odds.
                  </p>
                  <div className="push-bars">
                    {[...x.pushesFor, ...x.pushesAgainst].map((p) => (
                      <div className="push-row" key={p.label}>
                        <span className="input-label">{p.label}</span>
                        <span className="diverge">
                          <span className="diverge-half neg">
                            {p.value < 0 && (
                              <span
                                className="diverge-fill neg"
                                style={{ width: `${(Math.abs(p.value) / max) * 100}%` }}
                              />
                            )}
                          </span>
                          <span className="diverge-half pos">
                            {p.value > 0 && (
                              <span
                                className="diverge-fill pos"
                                style={{ width: `${(p.value / max) * 100}%` }}
                              />
                            )}
                          </span>
                        </span>
                        <span className="num small r">
                          {p.value > 0 ? "+" : ""}
                          {p.value.toFixed(2)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        }}
      </Load>
    </div>
  );
}
