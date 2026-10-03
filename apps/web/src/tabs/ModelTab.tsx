import { useState } from "react";
import { api, type GradedRates, type ModelInsights, type ModelRun } from "../api";
import { HBarChart, TargetBars } from "../components/Charts";
import { usePolling, useNow } from "../hooks";
import { ago, pct, tokenLabel, usd } from "../format";

const WINDOWS = [7, 30, 90] as const;

const LEARNER_NAME = { logistic: "Logistic regression", gbdt: "Gradient-boosted trees" } as const;

/** The Model & AI tab: how the picking is learning, and whether it is getting to 75% / 50%. */
export function ModelTab() {
  const now = useNow(60_000);
  const [days, setDays] = useState<(typeof WINDOWS)[number]>(30);
  const { data, error } = usePolling(
    () => api<ModelInsights>(`/curated/insights?days=${days}`),
    120_000,
    String(days),
  );

  if (error && !data) return <p className="error">Couldn't load model data: {error.message}</p>;
  if (!data) return <p className="muted">Loading model data…</p>;

  const t = data.targets;
  const latest = data.runs[0] ?? null;
  const base = data.samples.byKind.find((k) => k.kind === "event");
  const aiBuys = data.aiReviewer.byDecision.filter((d) => d.decision === "buy");
  const aiNoBuys = data.aiReviewer.byDecision.filter((d) => d.decision === "no_buy");

  return (
    <div className="stack">
      <section className="panel hero">
        <div>
          <h2>
            {data.curator.phase === "model-live" ? "A trained model is picking" : "The heuristic is picking"}
          </h2>
          <p className="muted">
            {data.curator.phase === "model-live"
              ? "The learner beat the hand-tuned heuristic on its walk-forward exam and took over."
              : "The learner retrains every few hours and takes over once it beats the heuristic out of sample."}{" "}
            Every pick then goes to the AI reviewer, which is in <strong>{data.curator.aiReviewMode}</strong>{" "}
            mode
            {data.curator.aiReviewMode === "shadow"
              ? ": it records a buy / no-buy call on each pick without blocking any."
              : data.curator.aiReviewMode === "gate"
                ? `: once ${data.curator.aiReviewMinGradedBuys} of its buys are graded and meet both targets, it blocks its no-buys.`
                : "."}
          </p>
          <p className="faint small">
            Win: {data.rules.win}. Goal: {data.rules.goal}. Fill: {data.rules.fill}.
          </p>
        </div>
        <div className="segmented" role="tablist" aria-label="Window">
          {WINDOWS.map((w) => (
            <button key={w} className={w === days ? "on" : ""} onClick={() => setDays(w)}>
              {w}d
            </button>
          ))}
        </div>
      </section>

      <section className="panel">
        <h3>Scoreboard, last {days} days</h3>
        <p className="muted small">
          Each row is a set of calls graded the same way. The base rate is what picking at random from the
          moments the curator considers would earn; every other row has to beat it.
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
                <th>
                  Against {t.hitRate2xPct}% / {t.hitRate4xPct}%
                </th>
              </tr>
            </thead>
            <tbody>
              <ScoreRow name="Curated picks (live feed)" r={data.curatedAlerts.total} />
              {data.curatedAlerts.bySource.length > 1 &&
                data.curatedAlerts.bySource.map((s) => (
                  <ScoreRow key={s.source} name={`· ${sourceName(s.source)}`} r={s} sub />
                ))}
              <ScoreRow name="Bench curator (shadow picks)" r={data.shadowEmissions.total} />
              <ScoreRow name="AI reviewer: buy calls" r={data.aiReviewer.buys} />
              {aiNoBuys.map((d) => (
                <ScoreRow key={`nb-${d.mode}`} name={`AI reviewer: no-buy calls (${d.mode})`} r={d} />
              ))}
              {base && <ScoreRow name="Base rate (all decision moments)" r={base} muted />}
            </tbody>
          </table>
        </div>
        {aiBuys.length === 0 && (
          <p className="faint small">
            No AI reviewer calls in this window. It needs ANTHROPIC_API_KEY on the worker.
          </p>
        )}
      </section>

      {latest ? (
        <LatestRun run={latest} targets={t} now={now} />
      ) : (
        <section className="panel">
          <h3>Training</h3>
          <p className="empty">
            No training run yet. The learner trains once enough graded decision moments exist.
          </p>
        </section>
      )}

      <div className="columns even">
        <section className="panel">
          <h3>What the model looks at</h3>
          {data.importance && data.importance.features.length > 0 ? (
            <>
              <p className="muted small">
                {LEARNER_NAME[data.importance.learner]}{" "}
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
          <h3>Is the AI reviewer calibrated?</h3>
          <p className="muted small">
            Its stated chance of a 2x, bucketed, against what those tokens actually did. A calibrated
            reviewer's 70-80% bucket wins about three times in four.
          </p>
          {data.aiReviewer.probability2xBands.length > 0 ? (
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
          ) : (
            <p className="empty">No graded reviewer calls yet.</p>
          )}
        </section>
      </div>

      <ConfidenceBands data={data} />

      <section className="panel">
        <h3>Latest AI reviewer calls</h3>
        {data.recentAiReviews.length === 0 ? (
          <p className="empty">None yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Token</th>
                  <th>When</th>
                  <th>Call</th>
                  <th className="r">P(2x)</th>
                  <th className="r">Mcap</th>
                  <th>Sent?</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {data.recentAiReviews.map((r) => (
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
                    <td className="muted">{r.alerted ? "alerted" : "held"}</td>
                    <td>{OUTCOME_TEXT[r.outcome]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data.recentAiReviews.some((r) => r.reasoning) && (
          <p className="faint small">Hover a row for the reviewer's reasoning (admin only).</p>
        )}
      </section>

      <section className="panel">
        <h3>Training history</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Trained</th>
                <th>Family</th>
                <th className="r">Rows</th>
                <th>Status</th>
                <th className="r">Cutoff 2x</th>
                <th className="r">Cutoff 4x</th>
                <th className="r">Support</th>
                <th>Verdict</th>
              </tr>
            </thead>
            <tbody>
              {data.runs.map((r) => (
                <tr key={r.id}>
                  <td className="muted">{ago(r.createdAt, now)}</td>
                  <td>{r.learner === "gbdt" ? "GBDT" : "Logistic"}</td>
                  <td className="r num">{r.trainingRows.toLocaleString()}</td>
                  <td>
                    <span className={`chip ${r.status === "active" ? "chip-model" : ""}`}>{r.status}</span>
                  </td>
                  <td className="r num">{pct(r.precisionCalibration?.winRatePct)}</td>
                  <td className="r num">{pct(r.precisionCalibration?.goalRatePct)}</td>
                  <td className="r num">{r.precisionCalibration?.support ?? "–"}</td>
                  <td className="muted small">{r.verdict?.reason ?? "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

const OUTCOME_TEXT: Record<ModelInsights["recentAiReviews"][number]["outcome"], string> = {
  pending: "◷ in its hour",
  won: "✓ 2x",
  won4x: "✓✓ 4x",
  missed: "✕ missed",
  stopped: "✕ stopped out",
  unknown: "–",
};

function sourceName(source: string): string {
  return source.startsWith("heuristic") ? "Heuristic" : `Model ${source.slice(-6)}`;
}

function ScoreRow({ name, r, sub, muted }: { name: string; r: GradedRates; sub?: boolean; muted?: boolean }) {
  const verdict =
    r.verdict === "meets-targets"
      ? { text: "✓ meets both", tone: "good" }
      : r.verdict === "below-targets"
        ? { text: "▼ below", tone: "bad" }
        : { text: "early: too few graded", tone: "neutral" };
  return (
    <tr className={`${sub ? "sub" : ""} ${muted ? "muted" : ""}`}>
      <td>{name}</td>
      <td className="r num">{r.calls.toLocaleString()}</td>
      <td className="r num">{r.graded.toLocaleString()}</td>
      <td className="r num">{pct(r.hitRate2xPct, 1)}</td>
      <td className="r num">{pct(r.hitRate4xPct, 1)}</td>
      <td>
        {muted ? (
          <span className="faint">reference</span>
        ) : (
          <span className={`badge ${verdict.tone}`}>{verdict.text}</span>
        )}
      </td>
    </tr>
  );
}

function LatestRun({ run, targets, now }: { run: ModelRun; targets: ModelInsights["targets"]; now: number }) {
  const [side, setSide] = useState<"model" | "heuristic">("model");
  const curve = side === "model" ? run.precisionCurve : run.heuristicPrecisionCurve;
  const cal = side === "model" ? run.precisionCalibration : run.heuristicCalibration;
  return (
    <section className="panel">
      <header className="section-head">
        <div>
          <h3>Latest training run</h3>
          <p className="muted small">
            {ago(run.createdAt, now)} on {run.trainingRows.toLocaleString()} graded moments. Shipped{" "}
            <strong>{LEARNER_NAME[run.learner]}</strong>, status <strong>{run.status}</strong>.
            {run.verdict && ` ${run.verdict.reason}`}
          </p>
        </div>
      </header>

      {run.familyComparison.length > 0 && (
        <>
          <h4>Logistic vs gradient-boosted trees, out of sample</h4>
          <div className="families">
            {run.familyComparison.map((f) => (
              <div key={f.learner} className={`family ${f.learner === run.learner ? "shipped" : ""}`}>
                <div className="row between">
                  <strong>{LEARNER_NAME[f.learner]}</strong>
                  {f.learner === run.learner && <span className="chip chip-model">shipped</span>}
                </div>
                <div className="family-figs">
                  <div>
                    <label>2x at cutoff</label>
                    <span className="num">{pct(f.precisionCalibration.winRatePct)}</span>
                  </div>
                  <div>
                    <label>4x at cutoff</label>
                    <span className="num">{pct(f.precisionCalibration.goalRatePct)}</span>
                  </div>
                  <div>
                    <label>Calls</label>
                    <span className="num">{f.precisionCalibration.support}</span>
                  </div>
                </div>
                <p className={`small state ${f.precisionCalibration.meetsTargets ? "met" : "below"}`}>
                  {f.precisionCalibration.meetsTargets
                    ? "✓ cutoff meets both targets"
                    : "▼ best cutoff falls short"}
                </p>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="row between wrap">
        <h4>Hit rate vs how picky the cutoff is</h4>
        <div className="segmented small">
          <button className={side === "model" ? "on" : ""} onClick={() => setSide("model")}>
            Model
          </button>
          <button className={side === "heuristic" ? "on" : ""} onClick={() => setSide("heuristic")}>
            Heuristic
          </button>
        </div>
      </div>
      <p className="muted small">
        Sending only the top slice of calls by confidence trades volume for hit rate. This is the
        out-of-sample record of each slice; the live cutoff is the loosest slice that clears both lines
        {cal?.support
          ? ` (now ${cal.support} calls at ${pct(cal.winRatePct)} / ${pct(cal.goalRatePct)})`
          : ""}
        .
      </p>
      {curve.length > 0 ? (
        <TargetBars
          aLabel="Doubled (2x)"
          bLabel="Reached 4x"
          aTarget={targets.hitRate2xPct}
          bTarget={targets.hitRate4xPct}
          data={curve.map((p, i) => ({
            // Slices too thin to hold one call are skipped from the front, so align from the end.
            label: `Top ${CURVE_SLICES[CURVE_SLICES.length - curve.length + i] ?? "?"}`,
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
                  <th className="r">Model calls</th>
                  <th className="r">Model 2x</th>
                  <th className="r">Heuristic calls</th>
                  <th className="r">Heuristic 2x</th>
                </tr>
              </thead>
              <tbody>
                {run.folds.map((f) => (
                  <tr key={f.testFrom}>
                    <td className="muted">
                      {new Date(f.testFrom).toLocaleDateString()} – {new Date(f.testTo).toLocaleDateString()}
                    </td>
                    <td className="r num">{f.testRows}</td>
                    <td className="r num">{pct(f.baseWinRatePct, 1)}</td>
                    <td className="r num">{f.model.emitted}</td>
                    <td className="r num">{pct(f.model.precisionPct)}</td>
                    <td className="r num">{f.heuristic.emitted}</td>
                    <td className="r num">{pct(f.heuristic.precisionPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}

/** precisionCurve's fixed slices, in the order trainer.ts writes them. */
const CURVE_SLICES = ["1%", "2%", "5%", "10%", "20%", "50%"];

function ConfidenceBands({ data }: { data: ModelInsights }) {
  const sides = [...new Set(data.curatorConfidenceBands.map((b) => b.side))];
  const [side, setSide] = useState<"heuristic" | "model">(
    data.curator.phase === "model-live" ? "model" : "heuristic",
  );
  const shown = sides.includes(side) ? side : sides[0];
  const bands = data.curatorConfidenceBands.filter((b) => b.side === shown);
  if (bands.length === 0) return null;
  return (
    <section className="panel">
      <div className="row between wrap">
        <h3>Hit rate by curator confidence, live and shadow</h3>
        {sides.length > 1 && (
          <div className="segmented small">
            {sides.map((s) => (
              <button key={s} className={s === shown ? "on" : ""} onClick={() => setSide(s)}>
                {s === "model" ? "Model" : "Heuristic"}
              </button>
            ))}
          </div>
        )}
      </div>
      <p className="muted small">If confidence means anything, the bars climb left to right.</p>
      <TargetBars
        aLabel="Doubled (2x)"
        bLabel="Reached 4x"
        aTarget={data.targets.hitRate2xPct}
        bTarget={data.targets.hitRate4xPct}
        data={bands.map((b) => ({
          label: `${b.band}-${b.band + 10}`,
          a: b.hitRate2xPct,
          b: b.hitRate4xPct,
          sub: `${b.graded} graded`,
        }))}
      />
    </section>
  );
}
