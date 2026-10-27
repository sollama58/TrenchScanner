import { useState, type ReactNode } from "react";
import { usePolling } from "../hooks";
import { pct } from "../format";
import { AdminLines } from "../components/AdminChart";
import { Kpi, Load, Panel, Table, Tag, n } from "./adminShared";
import {
  EXPLORER_PRESETS,
  explorerPath,
  bucketLabel,
  delta,
  seconds,
  type ExplorerWindow,
} from "./adminModelsExplorerView";

/**
 * The Admin Models "Explorer" (GET /admin/models/performance, apps/api/src/modelPerformance.ts):
 * the feed or one seat over any window from 30 minutes to 7 days, against the same span just
 * before it. KPIs carry the prior span's figure; the charts cut both spans into the same buckets
 * so a reader can see a trend start, not only a total.
 */

type Path = "cycle" | "fast" | "second" | "fresh";

interface Outcomes {
  calls: number;
  graded: number;
  pending: number;
  hit2xPct: number | null;
  hit4xPct: number | null;
  hit10xPct: number | null;
  afterStopPct: number | null;
  mix: { tenX: number; fourX: number; twoX: number; afterStop: number; miss: number } | null;
  predictedPct: number | null;
  simAvgPct: number | null;
  simOpen: number;
  peakMedianPct: number | null;
}

interface Coverage {
  rows: number;
  readPct: number | null;
  fullPct: number | null;
  xReadPct: number | null;
  tapePct: number | null;
}

interface Timing {
  coins: number;
  medianSec: number | null;
  p25Sec: number | null;
  p75Sec: number | null;
  p90Sec: number | null;
  under1mPct: number | null;
  under2mPct: number | null;
  launchMedianSec: number | null;
}

interface Period {
  since: string;
  until: string;
  alerts: number;
  coins: number;
  alertsPerHour: number;
  coinsPerHour: number;
  feed: Outcomes;
  market: Outcomes;
  entryMarket: Outcomes;
  lift: number | null;
  timing: Timing;
  coverage: Coverage;
  eventCoverage: Coverage;
  entryCoverage: Coverage;
}

interface PathRow {
  path: Path;
  sharePct: number | null;
  outcomes: Outcomes;
  lift: number | null;
  timing: Timing;
  coverage: Coverage;
}

interface ModelRow {
  id: string;
  name: string;
  calls: number;
  coins: number;
  callsPerHour: number;
  outcomes: Outcomes;
  lift: number | null;
  high: Outcomes;
  fastSharePct: number | null;
  cycle2xPct: number | null;
  fast2xPct: number | null;
  medianAgeSec: number | null;
  readPct: number | null;
  prior: {
    calls: number;
    graded: number;
    hit2xPct: number | null;
    lift: number | null;
    simAvgPct: number | null;
  };
}

interface Bucket {
  at: string;
  alerts: number;
  coins: number;
  graded: number;
  hit2xPct: number | null;
  base2xPct: number | null;
  lift: number | null;
  simAvgPct: number | null;
  medianDetectSec: number | null;
  readPct: number | null;
  fastSharePct: number | null;
}

interface Report {
  builtAt: string;
  model: string | null;
  modelName: string | null;
  minutes: number;
  bucketMinutes: number;
  current: Period;
  prior: Period;
  paths: PathRow[];
  models: ModelRow[];
  series: { current: Bucket[]; prior: Bucket[] };
  gradedThrough: string;
  minGradedForRate: number;
  truncated: boolean;
}

const PATH_LABEL: Record<Path, string> = {
  cycle: "Cycle (event moment)",
  fast: "Fast path (entry moment)",
  second: "Second look (Narrative)",
  fresh: "Fresh anchor",
};

const rate = (v: number | null | undefined) => (v === null || v === undefined ? "–" : pct(v, 1));
const num1 = (v: number | null | undefined) => (v === null || v === undefined ? "–" : v.toFixed(1));
const lift = (v: number | null | undefined) => (v === null || v === undefined ? "–" : `${v.toFixed(2)}×`);
const signed = (v: number | null | undefined) =>
  v === null || v === undefined ? "–" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;

export function ModelsExplorer({ seats }: { seats: readonly { id: string; name: string }[] }) {
  const [win, setWin] = useState<ExplorerWindow>({ kind: "preset", minutes: 24 * 60 });
  const [model, setModel] = useState<string>("");
  const [draft, setDraft] = useState<{ from: string; to: string }>({ from: "", to: "" });
  const [custom, setCustom] = useState(false);
  const path = explorerPath(win, model || null);
  // A preset follows the clock; a custom range is fixed, so it only needs reading once in a while.
  const q = usePolling<Report>(path, win.kind === "preset" ? 60_000 : 600_000);
  const options = [...seats];
  for (const m of q.data?.models ?? []) if (!options.some((s) => s.id === m.id)) options.push(m);

  const applyCustom = () => {
    const since = Date.parse(draft.from);
    const until = Date.parse(draft.to);
    if (Number.isFinite(since) && Number.isFinite(until) && until > since) {
      setWin({ kind: "range", since: new Date(since).toISOString(), until: new Date(until).toISOString() });
    }
  };

  return (
    <Panel
      title="Performance explorer"
      note="Any window from 30 minutes to 7 days, against the same span just before it. All models is the pooled feed (each grading row once); pick a seat for its own calls."
      actions={
        <div className="explorer-controls">
          <div className="segmented small" role="tablist" aria-label="Window">
            {EXPLORER_PRESETS.map((p) => {
              const on = !custom && win.kind === "preset" && win.minutes === p.minutes;
              return (
                <button
                  key={p.minutes}
                  role="tab"
                  aria-selected={on}
                  className={on ? "on" : ""}
                  onClick={() => {
                    setCustom(false);
                    setWin({ kind: "preset", minutes: p.minutes });
                  }}
                >
                  {p.label}
                </button>
              );
            })}
            <button
              role="tab"
              aria-selected={custom}
              className={custom ? "on" : ""}
              onClick={() => setCustom(true)}
            >
              Custom
            </button>
          </div>
          <select aria-label="Model" value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">All models (feed)</option>
            {options.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      }
    >
      {custom && (
        <div className="explorer-range">
          <label>
            From{" "}
            <input
              type="datetime-local"
              value={draft.from}
              onChange={(e) => setDraft({ ...draft, from: e.target.value })}
            />
          </label>
          <label>
            To{" "}
            <input
              type="datetime-local"
              value={draft.to}
              onChange={(e) => setDraft({ ...draft, to: e.target.value })}
            />
          </label>
          <button type="button" onClick={applyCustom}>
            Apply
          </button>
          <span className="faint small">Your local time. 30 minutes to 7 days, within the last 30 days.</span>
        </div>
      )}
      <Load q={q}>{(r) => <ExplorerBody r={r} onPickModel={setModel} />}</Load>
    </Panel>
  );
}

export function ExplorerBody({ r, onPickModel }: { r: Report; onPickModel: (id: string) => void }) {
  const cur = r.current;
  const pri = r.prior;
  const label = (i: number) => bucketLabel(r.series.current[i]?.at ?? "", r.minutes);
  const pair = (pick: (b: Bucket) => number | null) =>
    r.series.current.map((b, i) => ({
      label: label(i),
      values: [pick(b), r.series.prior[i] ? pick(r.series.prior[i]!) : null],
    }));
  const who = r.modelName ?? "Feed";
  return (
    <div className="stack">
      <p className="faint small">
        {who}: {new Date(cur.since).toLocaleString()} to {new Date(cur.until).toLocaleString()}, against{" "}
        {new Date(pri.since).toLocaleString()} to {new Date(pri.until).toLocaleString()}. Buckets of{" "}
        {r.bucketMinutes >= 60 ? `${r.bucketMinutes / 60} h` : `${r.bucketMinutes} min`}.
      </p>
      <div className="kpis">
        <Kpi
          label="Alerts / h"
          value={num1(cur.alertsPerHour)}
          sub={`${n(cur.alerts)} on ${n(cur.coins)} coins · prior ${num1(pri.alertsPerHour)} (${delta(cur.alertsPerHour, pri.alertsPerHour, "%")})`}
        />
        <Kpi
          label="Hit 2x"
          value={rate(cur.feed.hit2xPct)}
          tone={
            cur.feed.hit2xPct !== null && pri.feed.hit2xPct !== null && cur.feed.hit2xPct >= pri.feed.hit2xPct
              ? "ok"
              : undefined
          }
          sub={`${n(cur.feed.graded)} graded, ${n(cur.feed.pending)} pending · prior ${rate(pri.feed.hit2xPct)} (${delta(cur.feed.hit2xPct, pri.feed.hit2xPct, "pts")})`}
        />
        <Kpi
          label="Hit 4x · 10x"
          value={`${rate(cur.feed.hit4xPct)} · ${rate(cur.feed.hit10xPct)}`}
          sub={`prior ${rate(pri.feed.hit4xPct)} · ${rate(pri.feed.hit10xPct)}`}
        />
        <Kpi
          label="Market base 2x"
          value={rate(cur.market.hit2xPct)}
          sub={`${n(cur.market.graded)} event moments · prior ${rate(pri.market.hit2xPct)}`}
        />
        <Kpi
          label="Lift"
          value={lift(cur.lift)}
          tone={cur.lift !== null && cur.lift >= 1 ? "ok" : cur.lift !== null ? "warn" : undefined}
          sub={`prior ${lift(pri.lift)} (${delta(cur.lift, pri.lift, "x")})`}
        />
        <Kpi
          label="Predicted vs actual"
          value={`${rate(cur.feed.predictedPct)} → ${rate(cur.feed.hit2xPct)}`}
          sub="the calibrated 2x rate stated at the call, then what happened"
        />
        <Kpi
          label="Avg exit-plan return"
          value={signed(cur.feed.simAvgPct)}
          sub={`median peak ${signed(cur.feed.peakMedianPct)} · prior ${signed(pri.feed.simAvgPct)}${cur.feed.simOpen ? ` · ${n(cur.feed.simOpen)} still open` : ""}`}
        />
        <Kpi
          label="Detection → first alert"
          value={seconds(cur.timing.medianSec)}
          sub={`${rate(cur.timing.under1mPct)} under 1 min, ${rate(cur.timing.under2mPct)} under 2 · prior ${seconds(pri.timing.medianSec)}`}
        />
        <Kpi
          label="TokenSage read on calls"
          value={rate(cur.coverage.readPct)}
          sub={`full depth ${rate(cur.coverage.fullPct)} · tape ${rate(cur.coverage.tapePct)} · prior ${rate(pri.coverage.readPct)}`}
        />
      </div>

      <div className="admin-split">
        <Panel
          title="2x rate vs the market"
          note={`Per bucket. A gap is a bucket under ${r.minGradedForRate} graded calls.`}
        >
          <AdminLines
            label="2x rate and market base by bucket"
            points={r.series.current.map((b, i) => ({ label: label(i), values: [b.hit2xPct, b.base2xPct] }))}
            names={[`${who} 2x %`, "Market 2x %"]}
            empty="Nothing graded in this window yet."
          />
        </Panel>
        <Panel
          title="2x rate: this span vs the one before"
          note="The prior span's bucket at the same offset."
        >
          <AdminLines
            label="2x rate now and in the prior span"
            points={pair((b) => b.hit2xPct)}
            names={["Now 2x %", "Prior 2x %"]}
            empty="Nothing graded in either span."
          />
        </Panel>
        <Panel title="Lift: now vs prior" note="2x rate over the event moments' 2x rate in the same bucket.">
          <AdminLines
            label="Lift now and in the prior span"
            points={pair((b) => b.lift)}
            names={["Now lift", "Prior lift"]}
            empty="Not enough graded calls per bucket."
          />
        </Panel>
        <Panel title="Alerts: now vs prior" note="Alerts per bucket.">
          <AdminLines
            label="Alerts per bucket now and in the prior span"
            points={pair((b) => b.alerts)}
            names={["Now alerts", "Prior alerts"]}
            empty="No alerts."
          />
        </Panel>
        <Panel
          title="Detection → first alert"
          note="Median seconds from detection to the coin's first alert."
        >
          <AdminLines
            label="Median detection to alert seconds, now and prior"
            points={pair((b) => b.medianDetectSec)}
            names={["Now median s", "Prior median s"]}
            empty="No first alerts."
          />
        </Panel>
        <Panel title="Exit-plan return: now vs prior" note="Average simulated return per bucket.">
          <AdminLines
            label="Average return now and in the prior span"
            points={pair((b) => b.simAvgPct)}
            names={["Now avg return %", "Prior avg return %"]}
            empty="No returns graded yet."
          />
        </Panel>
        <Panel title="TokenSage read on calls" note="Share of calls whose decision had TokenSage's read in.">
          <AdminLines
            label="TokenSage read share now and prior"
            points={pair((b) => b.readPct)}
            names={["Now read %", "Prior read %"]}
            empty="No calls."
          />
        </Panel>
        <Panel title="Fast-path share" note="Share of alerts anchored on a fast-path (entry) decision.">
          <AdminLines
            label="Fast-path share now and prior"
            points={pair((b) => b.fastSharePct)}
            names={["Now fast %", "Prior fast %"]}
            empty="No alerts."
          />
        </Panel>
      </div>

      <h3>Outcomes</h3>
      <Table
        head={[
          "Span",
          "Calls",
          "Graded",
          "10x",
          "4x",
          "2x",
          "Doubled after stop",
          "Miss",
          "Pending",
          "Predicted 2x",
        ]}
        rows={(
          [
            ["This span", cur.feed],
            ["Prior span", pri.feed],
            ["Market (event moments)", cur.market],
            ["Fast-path moments", cur.entryMarket],
          ] as const
        ).map(([name, o]) => [
          <strong key="n">{name}</strong>,
          n(o.calls),
          n(o.graded),
          rate(o.mix?.tenX),
          rate(o.mix?.fourX),
          rate(o.mix?.twoX),
          rate(o.mix?.afterStop),
          rate(o.mix?.miss),
          n(o.pending),
          rate(o.predictedPct),
        ])}
      />
      <p className="faint small">
        The outcome columns split the graded calls so they add to 100%; the KPIs above count every 2x and 4x.
      </p>

      <h3>Fast path vs cycle</h3>
      <Table
        head={[
          "Decision",
          "Share",
          "Calls",
          "Graded",
          "2x",
          "4x",
          "Predicted",
          "Lift (own base)",
          "Detect → alert",
          "Under 1 min",
          "Read",
          "Full read",
          "Tape",
        ]}
        rows={r.paths.map((p) => [
          <strong key="p">{PATH_LABEL[p.path]}</strong>,
          rate(p.sharePct),
          n(p.outcomes.calls),
          n(p.outcomes.graded),
          rate(p.outcomes.hit2xPct),
          rate(p.outcomes.hit4xPct),
          rate(p.outcomes.predictedPct),
          lift(p.lift),
          seconds(p.timing.medianSec),
          rate(p.timing.under1mPct),
          rate(p.coverage.readPct),
          rate(p.coverage.fullPct),
          rate(p.coverage.tapePct),
        ])}
        empty="No alerts in this window."
      />
      <p className="faint small">
        The path is the alert's anchor row. A fast-path call's lift is over the fast-path moments' own 2x rate
        ({rate(cur.entryMarket.hit2xPct)}), the cycle's over the event moments' ({rate(cur.market.hit2xPct)}).
        A fresh anchor is a call made on a row of its own, which every fast-path call was before 26 Oct 20:35
        UTC.
      </p>

      <h3>By model</h3>
      <Table
        head={[
          "Model",
          "Calls (/h)",
          "Graded",
          "2x",
          "vs prior",
          "4x",
          "10x",
          "Avg return",
          "Lift",
          "High tier 2x",
          "Fast share",
          "Cycle · fast 2x",
          "Detect → call",
          "Read",
        ]}
        rows={r.models.map((m) => [
          <button key="m" type="button" className="link" onClick={() => onPickModel(m.id)}>
            {m.name}
          </button>,
          `${n(m.calls)} (${num1(m.callsPerHour)})`,
          n(m.outcomes.graded),
          rate(m.outcomes.hit2xPct),
          <Change key="d" now={m.outcomes.hit2xPct} before={m.prior.hit2xPct} />,
          rate(m.outcomes.hit4xPct),
          rate(m.outcomes.hit10xPct),
          signed(m.outcomes.simAvgPct),
          lift(m.lift),
          m.high.calls > 0 ? `${rate(m.high.hit2xPct)} (${n(m.high.graded)})` : "–",
          rate(m.fastSharePct),
          `${rate(m.cycle2xPct)} · ${rate(m.fast2xPct)}`,
          seconds(m.medianAgeSec),
          rate(m.readPct),
        ])}
        empty="No calls in this window."
      />

      <h3>Input coverage</h3>
      <Table
        head={["Rows", "Count", "TokenSage read", "Full depth", "X read", "Curve tape"]}
        rows={(
          [
            [r.model ? "This seat's calls" : "Feed calls", cur.coverage],
            ["Cycle decision moments", cur.eventCoverage],
            ["Fast-path decision moments", cur.entryCoverage],
            [r.model ? "This seat's calls, prior span" : "Feed calls, prior span", pri.coverage],
          ] as const
        ).map(([name, c]) => [
          <strong key="c">{name}</strong>,
          n(c.rows),
          rate(c.readPct),
          rate(c.fullPct),
          rate(c.xReadPct),
          rate(c.tapePct),
        ])}
      />
      <p className="faint small">
        Detection → first alert: p25 {seconds(cur.timing.p25Sec)}, median {seconds(cur.timing.medianSec)}, p75{" "}
        {seconds(cur.timing.p75Sec)}, p90 {seconds(cur.timing.p90Sec)} over {n(cur.timing.coins)} coins;
        launch → alert median {seconds(cur.timing.launchMedianSec)}. Calls newer than{" "}
        {new Date(r.gradedThrough).toLocaleTimeString()} are still inside their grading window, so the newest
        buckets read thin. Rates count graded calls only; the base is the event moments that pass today's
        wallet screen.
        {r.truncated && " The read hit its row cap, so the window is cut short."}
      </p>
    </div>
  );
}

function Change({ now, before }: { now: number | null; before: number | null }): ReactNode {
  if (now === null || before === null) return <span className="faint">–</span>;
  const d = Math.round((now - before) * 10) / 10;
  if (Math.abs(d) < 0.05) return <span className="faint">±0</span>;
  return (
    <Tag tone={d > 0 ? "ok" : "bad"}>
      {d > 0 ? "+" : ""}
      {d.toFixed(1)} pts
    </Tag>
  );
}
