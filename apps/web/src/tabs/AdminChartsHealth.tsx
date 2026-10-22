import { usePolling } from "../hooks";
import { pct } from "../format";
import { Kpi, Load, Panel, Table, Tag, n, when } from "./adminShared";

type Tone = "ok" | "warn" | "bad";

/** GET /admin/charts-health (apps/api/src/chartHealth.ts), this API instance's last 5 minutes. */
interface ChartsHealthReport {
  windowMs: number;
  since: string;
  status: Tone;
  candles: {
    answers: number;
    bySource: Record<string, number>;
    null: number;
    stale: number;
    /** Short of the coin's history (stream only, or starting well after launch); absent from older API builds. */
    partial?: number;
    nullOrStaleShare: number | null;
  };
  liveTail: { answers: number; bySource: Record<string, number> };
  stream: { stalledForMs: number; reconnects: number; stalls: number; verified: number; mismatches: number };
  rpc: { heliusFailures: number; backupReads: number; backupFailures: number };
  pumpFunGate: { requests: number; throttled: number; heldBack: number };
  solPrice: { failures: number; missing: number };
  clientErrors: { total: number; byWhere: Record<string, number> };
  metrics: { key: string; label: string; window: number; sinceBoot: number; tone: Tone; threshold: string }[];
  liveCurves?: { followed: number; charts?: number; streamed: number };
}

const TONE_LABEL: Record<Tone, string> = { ok: "OK", warn: "Watch", bad: "Act" };

/** "a 3 · b 1", biggest first; "–" when empty. */
function counts(by: Record<string, number>): string {
  const rows = Object.entries(by).sort((a, b) => b[1] - a[1]);
  return rows.length === 0 ? "–" : rows.map(([k, v]) => `${k} ${v.toLocaleString()}`).join(" · ");
}

/**
 * Admin > API's "Charts health" (charts robustness audit 2026-10-19): what the token chart's routes
 * answered lately, whether the live tail's socket and its RPC checks hold, Pump.fun's budget and
 * browsers' error reports. Green, amber and red come from the API, which also tells the admins on
 * Telegram when candles go blank or the socket stalls.
 */
export function ChartsHealth() {
  const q = usePolling<ChartsHealthReport>("/admin/charts-health", 30_000);
  return (
    <Panel title="Charts health" note="This API instance, the last 5 minutes. Counts reset on a deploy.">
      <Load q={q}>
        {(h) => (
          <div className="stack">
            <div className="kpis">
              <Kpi
                label="Status"
                value={<Tag tone={h.status}>{TONE_LABEL[h.status]}</Tag>}
                sub={<>counting since {when(h.since)}</>}
              />
              <Kpi
                label="Candles null or stale"
                value={h.candles.nullOrStaleShare === null ? "–" : pct(h.candles.nullOrStaleShare * 100)}
                sub={`${n(h.candles.answers)} answers · ${n(h.candles.null)} null · ${n(h.candles.stale)} stale${h.candles.partial !== undefined ? ` · ${n(h.candles.partial)} partial` : ""}`}
                tone={
                  h.candles.nullOrStaleShare !== null && h.candles.nullOrStaleShare >= 0.1 ? "warn" : "ok"
                }
              />
              <Kpi
                label="Chart socket"
                value={
                  h.stream.stalledForMs > 0
                    ? `Silent ${Math.round(h.stream.stalledForMs / 1000)}s`
                    : "Speaking"
                }
                sub={`${n(h.stream.reconnects)} reconnects · ${n(h.stream.mismatches)} missed of ${n(h.stream.verified)} checked`}
                tone={h.stream.stalledForMs > 0 || h.stream.mismatches > 0 ? "warn" : "ok"}
              />
              <Kpi
                label="Live tails"
                value={n(h.liveCurves?.followed)}
                sub={`followed · ${n(h.liveCurves?.charts)} by charts · ${n(h.liveCurves?.streamed)} on the stream`}
              />
            </div>
            <Table
              head={["Check", "Last 5 min", "Since boot", "Status", "Thresholds"]}
              rows={h.metrics.map((m) => [
                m.label,
                n(m.window),
                n(m.sinceBoot),
                <Tag tone={m.tone}>{TONE_LABEL[m.tone]}</Tag>,
                <span className="muted small">{m.threshold}</span>,
              ])}
            />
            <Table
              head={["Feed", "Answers (last 5 min)"]}
              rows={[
                ["Candles by source", counts(h.candles.bySource)],
                ["Live tail by source", counts(h.liveTail.bySource)],
                [
                  "RPC reads",
                  `${n(h.rpc.heliusFailures)} unanswered by Helius · ${n(h.rpc.backupReads)} retried on the backup · ${n(h.rpc.backupFailures)} failed there too`,
                ],
                [
                  "Pump.fun gate",
                  `${n(h.pumpFunGate.requests)} sent · ${n(h.pumpFunGate.heldBack)} held back · ${n(h.pumpFunGate.throttled)} 429s`,
                ],
                [
                  "SOL price",
                  `${n(h.solPrice.failures)} failed reads · ${n(h.solPrice.missing)} answers without a price`,
                ],
                ["Browser errors by place", counts(h.clientErrors.byWhere)],
              ]}
            />
          </div>
        )}
      </Load>
    </Panel>
  );
}
