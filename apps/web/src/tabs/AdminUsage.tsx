import { useState } from "react";
import { TrendChart } from "../components/TrendChart";
import { usePolling } from "../hooks";
import type { Series } from "../lighthouseMetrics";
import { pct } from "../format";
import { Kpi, Load, Panel, Table, Tag, ms, n, when } from "./adminShared";

/**
 * Admin > API usage: every outside call the API, the scanner and the trainer make, counted where
 * they all pass (fetch) and kept in 5-minute rows - per provider, per endpoint (the RPC method,
 * for Helius) and per feature (the job, and the scan's stage). Helius credits are estimated from
 * its published per-method prices; the Helius dashboard is the billed number.
 */

type UsageWindow = "1h" | "24h" | "7d";

interface Totals {
  calls: number;
  requests: number;
  errors: number;
  rateLimited: number;
  credits: number;
  avgMs: number | null;
}

interface ApiUsageReport {
  window: UsageWindow;
  since: string;
  stepMs: number;
  countingSince: string | null;
  helius: { lastHour: number; last24h: number; last7d: number; projected30d: number };
  total: Totals;
  providers: ({ provider: string } & Totals)[];
  endpoints: ({ provider: string; endpoint: string } & Totals)[];
  features: ({ feature: string; heliusCredits: number; byProvider: Record<string, number> } & Totals)[];
  processes: { process: string; calls: number; credits: number }[];
  buckets: number[];
  callsByProvider: { provider: string; values: number[] }[];
  heliusCreditsByFeature: { feature: string; values: number[] }[];
}

interface TokenSageUsage {
  configured: boolean;
  error: string | null;
  sources: { source: string; calls: number; errors: number; rateLimited: number; avgMs: number | null }[];
  helius: {
    lastHour: number;
    last24h: number;
    last7d: number;
    cycleToDate: number;
    planCredits: number;
    projectedCycle: number;
    projectedPct: number;
  } | null;
}

const WINDOWS: { id: UsageWindow; label: string }[] = [
  { id: "1h", label: "Last hour" },
  { id: "24h", label: "24 hours" },
  { id: "7d", label: "7 days" },
];

/** Readable provider names; anything else shows its host. */
const PROVIDER_LABEL: Record<string, string> = {
  helius: "Helius",
  dexscreener: "DexScreener",
  geckoterminal: "GeckoTerminal",
  coingecko: "CoinGecko",
  jupiter: "Jupiter",
  pumpfun: "Pump.fun",
  rugcheck: "RugCheck",
  telegram: "Telegram",
  anthropic: "Anthropic",
  tokensage: "TokenSage",
  "solana-public-rpc": "Public Solana RPC",
};
const providerName = (p: string) => PROVIDER_LABEL[p] ?? p;
/** "scan/linkedWallets" -> "scan › linkedWallets"; an API route ("api /tokens/:mint") stays as it is. */
const featureName = (f: string) => (f.startsWith("api ") ? f : f.split("/").join(" › "));

/** A compact count: 1,234 / 12.3k / 1.2M. */
function compact(v: number): string {
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`;
  if (v >= 1e4) return `${(v / 1e3).toFixed(v >= 1e5 ? 0 : 1)}k`;
  return v.toLocaleString();
}

const errorCell = (t: Totals) =>
  t.errors === 0 ? (
    "0"
  ) : (
    <Tag tone={t.errors / Math.max(1, t.calls) >= 0.05 ? "bad" : "warn"}>
      {n(t.errors)}
      {t.rateLimited > 0 ? ` (${n(t.rateLimited)} 429)` : ""}
    </Tag>
  );

/** Bar labels for the window: clock times for the hour and the day, day + time for the week. */
function bucketLabels(buckets: number[], stepMs: number): { short: string; full: string }[] {
  const hm = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return buckets.map((t) => {
    const d = new Date(t);
    const day = d.toLocaleDateString([], { weekday: "short" });
    const hour = `${String(d.getHours()).padStart(2, "0")}h`;
    return {
      // Short enough that the axis keeps a label every few bars at phone width.
      short: stepMs >= 6 * 3_600_000 ? `${day} ${hour}` : stepMs >= 3_600_000 ? hour : hm(d),
      full: `${day} ${hm(d)}–${hm(new Date(t + stepMs))}`,
    };
  });
}

/** Up to five series in the colour slots, by total; the rest pooled as "other". */
function topSeries(rows: { label: string; values: number[] }[]): Series[] {
  const sorted = [...rows].sort(
    (a, b) => b.values.reduce((x, y) => x + y, 0) - a.values.reduce((x, y) => x + y, 0),
  );
  const head = sorted.filter((r) => r.label !== "other").slice(0, 5);
  const rest = sorted.filter((r) => !head.includes(r));
  const out: Series[] = head.map((r, i) => ({
    id: r.label,
    label: r.label,
    unit: "count",
    values: r.values,
    slot: i + 1,
  }));
  if (rest.length > 0 && rest.some((r) => r.values.some((v) => v > 0))) {
    const len = rest[0]!.values.length;
    out.push({
      id: "other",
      label: "Other",
      unit: "count",
      values: Array.from({ length: len }, (_, i) => rest.reduce((a, r) => a + (r.values[i] ?? 0), 0)),
      slot: 0,
    });
  }
  return out;
}

export function UsageAdmin() {
  const [win, setWin] = useState<UsageWindow>("24h");
  const [chart, setChart] = useState<"credits" | "calls">("credits");
  const q = usePolling<ApiUsageReport>(`/admin/api-usage?window=${win}`, 60_000);
  const ts = usePolling<TokenSageUsage>(`/admin/api-usage/tokensage?window=${win}`, 120_000);
  return (
    <div className="stack">
      <div className="segmented" role="tablist" aria-label="Usage window">
        {WINDOWS.map((w) => (
          <button
            key={w.id}
            role="tab"
            aria-selected={win === w.id}
            className={win === w.id ? "on" : ""}
            onClick={() => setWin(w.id)}
          >
            {w.label}
          </button>
        ))}
      </div>
      <Load q={q}>
        {(r) => {
          const helius = r.providers.find((p) => p.provider === "helius");
          const labels = bucketLabels(r.buckets, r.stepMs);
          const series =
            chart === "credits"
              ? topSeries(
                  r.heliusCreditsByFeature.map((s) => ({ label: featureName(s.feature), values: s.values })),
                )
              : topSeries(
                  r.callsByProvider.map((s) => ({ label: providerName(s.provider), values: s.values })),
                );
          const partial =
            r.countingSince !== null && new Date(r.countingSince).getTime() > Date.parse(r.since);
          return (
            <div className="stack">
              {r.countingSince === null ? (
                <p className="small muted">
                  No calls counted yet. Each process adds its counts every minute after it starts.
                </p>
              ) : (
                partial && (
                  <p className="small muted">
                    Counting started {when(r.countingSince)}, so this window is partial.
                  </p>
                )
              )}
              <div className="kpis">
                <Kpi
                  label="Helius credits"
                  value={compact(helius?.credits ?? 0)}
                  sub={`${n(helius?.calls ?? 0)} RPC calls in ${n(helius?.requests ?? 0)} requests`}
                />
                <Kpi
                  label="Helius pace"
                  value={compact(r.helius.last24h)}
                  sub={`credits last 24h · ~${compact(r.helius.projected30d)} per 30 days`}
                />
                <Kpi
                  label="All outside calls"
                  value={compact(r.total.calls)}
                  sub={`${r.providers.length} providers · ${compact(r.total.requests)} HTTP requests`}
                />
                <Kpi
                  label="Failed"
                  value={r.total.calls > 0 ? pct((100 * r.total.errors) / r.total.calls, 1) : "–"}
                  sub={`${n(r.total.errors)} calls · ${n(r.total.rateLimited)} rate-limited (429)`}
                  tone={r.total.calls > 0 && r.total.errors / r.total.calls >= 0.05 ? "warn" : undefined}
                />
              </div>
              <Panel
                title={chart === "credits" ? "Helius credits by feature" : "Calls by provider"}
                note="Stacked per bar; the last bar is still filling. Hover or tap a bar for its numbers."
                actions={
                  <div className="segmented" role="tablist" aria-label="Chart">
                    <button
                      role="tab"
                      aria-selected={chart === "credits"}
                      className={chart === "credits" ? "on" : ""}
                      onClick={() => setChart("credits")}
                    >
                      Credits
                    </button>
                    <button
                      role="tab"
                      aria-selected={chart === "calls"}
                      className={chart === "calls" ? "on" : ""}
                      onClick={() => setChart("calls")}
                    >
                      Calls
                    </button>
                  </div>
                }
              >
                {series.length === 0 ? (
                  <p className="muted small">Nothing in this window.</p>
                ) : (
                  <TrendChart labels={labels} series={series} kind="stacked" partialLast />
                )}
              </Panel>
              <Panel
                title="By provider"
                note="Calls are what a provider bills or rate-limits on: a JSON-RPC batch of 80 is 80 calls in one request. Credits are only charged by Helius (and CoinGecko's paid API)."
              >
                <Table
                  head={["Provider", "Calls", "Requests", "Credits", "Failed", "Avg request"]}
                  rows={r.providers.map((p) => [
                    providerName(p.provider),
                    n(p.calls),
                    n(p.requests),
                    p.credits > 0 ? <b>{n(p.credits)}</b> : <span className="faint">–</span>,
                    errorCell(p),
                    ms(p.avgMs),
                  ])}
                  empty="No outside calls in this window."
                />
              </Panel>
              <Panel
                title="By feature"
                note="The job that made the call, and for the scan the stage it was in. API routes count under the route."
              >
                <Table
                  head={["Feature", "Helius credits", "Calls", "Failed", "Calls by provider"]}
                  rows={r.features.map((f) => [
                    <code>{featureName(f.feature)}</code>,
                    f.heliusCredits > 0 ? <b>{n(f.heliusCredits)}</b> : <span className="faint">–</span>,
                    n(f.calls),
                    errorCell(f),
                    <span className="small muted">
                      {Object.entries(f.byProvider)
                        .sort((a, b) => b[1] - a[1])
                        .map(([p, c]) => `${providerName(p)} ${compact(c)}`)
                        .join(" · ")}
                    </span>,
                  ])}
                  empty="No outside calls in this window."
                />
              </Panel>
              <Panel
                title="By endpoint"
                note="The RPC method for Helius and other RPC hosts, the route for the rest (ids taken out). Costliest first."
              >
                <Table
                  head={["Provider", "Endpoint", "Calls", "Credits", "Failed", "Avg request"]}
                  rows={r.endpoints.map((e) => [
                    providerName(e.provider),
                    <code>{e.endpoint}</code>,
                    n(e.calls),
                    e.credits > 0 ? n(e.credits) : <span className="faint">–</span>,
                    errorCell(e),
                    ms(e.avgMs),
                  ])}
                  empty="No outside calls in this window."
                />
              </Panel>
              {r.processes.length > 0 && (
                <p className="small muted">
                  By process:{" "}
                  {r.processes
                    .map(
                      (p) =>
                        `${p.process} ${compact(p.calls)} calls${p.credits ? `, ${compact(p.credits)} credits` : ""}`,
                    )
                    .join(" · ")}
                  . Helius credits are estimates from its per-method prices; its dashboard has the billed
                  figure.
                </p>
              )}
            </div>
          );
        }}
      </Load>
      <Panel
        title="TokenSage's own calls"
        note="What the TokenSage service calls itself, from its own meter."
      >
        <Load q={ts}>
          {(t) =>
            !t.configured ? (
              <p className="small muted">
                Not connected. Set TOKENSAGE_MONITOR_KEY (TokenSage's read-only MONITOR_KEY) on the API
                service to show TokenSage's own calls and Helius credits here.
              </p>
            ) : (
              <div className="stack">
                {t.error && <p className="error small">TokenSage didn't answer in full: {t.error}</p>}
                {t.helius && (
                  <div className="kpis">
                    <Kpi
                      label="TokenSage Helius credits"
                      value={compact(t.helius.last24h)}
                      sub={`last 24h · ${compact(t.helius.lastHour)} last hour · ${compact(t.helius.last7d)} 7d`}
                    />
                    <Kpi
                      label="Its billing cycle"
                      value={compact(t.helius.cycleToDate)}
                      sub={`of ${compact(t.helius.planCredits)} · on pace for ${pct(t.helius.projectedPct, 0)}`}
                      tone={t.helius.projectedPct >= 90 ? "warn" : undefined}
                    />
                  </div>
                )}
                <Table
                  head={["Source", "Calls", "Failed", "Avg request"]}
                  rows={t.sources.map((s) => [
                    s.source,
                    n(s.calls),
                    s.errors === 0 ? (
                      "0"
                    ) : (
                      <Tag tone="warn">
                        {n(s.errors)}
                        {s.rateLimited > 0 ? ` (${n(s.rateLimited)} 429)` : ""}
                      </Tag>
                    ),
                    ms(s.avgMs),
                  ])}
                  empty="No calls in this window."
                />
              </div>
            )
          }
        </Load>
      </Panel>
    </div>
  );
}
