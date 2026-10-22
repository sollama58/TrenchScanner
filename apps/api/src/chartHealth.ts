import { createLogger, escapeHtml, takePumpFunGateStats } from "@trenchscanner/core";

const logger = createLogger("chart-health");

/**
 * The token chart's health on this API instance (user ask 2026-10-19: "fix all", after the charts
 * robustness audit's monitoring gaps). Until now a chart failing showed only as logger.warn lines
 * and in users' reports: /stats/routes counts 5xx answers, and a 200 with `candles: null`, a frozen
 * "stream" answer or a held-back Pump.fun read all counted as success.
 *
 * In memory only, over a rolling window of minute buckets: what the chart routes answered (candles
 * by source, null and stale; the live tail by source), the chart socket's reconnects and stalls,
 * covered accounts the RPC check found the stream had missed (liveCurve.ts), RPC reads that failed
 * on both routes, Pump.fun's gate for this process (the worker reads its own), SOL price failures
 * and the web's error reports (POST /client-errors). Read by /health (nested), Admin > API's
 * "Charts health" panel (/admin/charts-health), and the alert below, which tells the admins on
 * Telegram when charts are blank or frozen for many users at once.
 *
 * A deploy resets it (one instance; nothing is stored), which is fine for a 5-minute view.
 */

const MINUTE_MS = 60_000;
/** The window the panel and the alert judge: long enough to mean something, short enough to act. */
export const CHART_HEALTH_WINDOW_MS = 5 * MINUTE_MS;
/** Minute buckets kept (the window, and a little more for the minute still filling). */
const BUCKETS = 6;
/** Distinct names a free-text label (a client error's `where`) may take before the rest pool as "other". */
const MAX_LABELS = 50;

/** Counts per name over the last BUCKETS minutes, plus totals since boot. */
class RollingCounts {
  private readonly buckets = new Map<number, Map<string, number>>();
  private readonly totals = new Map<string, number>();

  add(name: string, n: number, now: number): void {
    if (!(n > 0)) return;
    const minute = Math.floor(now / MINUTE_MS);
    let bucket = this.buckets.get(minute);
    if (!bucket) {
      this.buckets.set(minute, (bucket = new Map()));
      for (const m of this.buckets.keys()) if (m <= minute - BUCKETS) this.buckets.delete(m);
    }
    bucket.set(name, (bucket.get(name) ?? 0) + n);
    this.totals.set(name, (this.totals.get(name) ?? 0) + n);
  }

  /** Each name's count over the last `windowMs` (whole minutes, the current one included). */
  window(windowMs: number, now: number): Map<string, number> {
    const from = Math.floor(now / MINUTE_MS) - Math.ceil(windowMs / MINUTE_MS) + 1;
    const out = new Map<string, number>();
    for (const [minute, bucket] of this.buckets) {
      if (minute < from) continue;
      for (const [name, n] of bucket) out.set(name, (out.get(name) ?? 0) + n);
    }
    return out;
  }

  total(name: string): number {
    return this.totals.get(name) ?? 0;
  }

  /** Every name seen since boot that starts with `prefix`. */
  names(prefix: string): string[] {
    return [...this.totals.keys()].filter((k) => k.startsWith(prefix));
  }

  clear(): void {
    this.buckets.clear();
    this.totals.clear();
  }
}

export type HealthTone = "ok" | "warn" | "bad";

/** One judged figure: its count in the window, since boot, and how it reads. */
export interface ChartHealthMetric {
  key: string;
  label: string;
  window: number;
  sinceBoot: number;
  tone: HealthTone;
  /** What amber and red mean for it, in words, for the panel. */
  threshold: string;
}

export interface ChartHealthSnapshot {
  windowMs: number;
  since: string;
  /** The worst tone of the metrics. */
  status: HealthTone;
  /** Candle answers (GET /chart, /chart/fine) in the window, by feed and source; null and stale. */
  candles: {
    answers: number;
    bySource: Record<string, number>;
    null: number;
    stale: number;
    /**
     * Answers with candles short of the coin's history: the stream's alone (since a chart opened),
     * or a first candle well after the launch (/chart only). They draw, so they aren't null.
     */
    partial: number;
    /** (null + stale) / answers, 0..1, or null under CANDLE_SHARE_MIN_ANSWERS answers. */
    nullOrStaleShare: number | null;
  };
  /** Live tail answers (GET .../chart/live) in the window, by source. */
  liveTail: { answers: number; bySource: Record<string, number> };
  stream: {
    /** How long the chart socket has been silent past its stall limit now (ms), 0 while it speaks. */
    stalledForMs: number;
    reconnects: number;
    stalls: number;
    /** Covered accounts read by RPC to check the stream, and those found to differ. */
    verified: number;
    mismatches: number;
  };
  rpc: { heliusFailures: number; backupReads: number; backupFailures: number };
  pumpFunGate: { requests: number; throttled: number; heldBack: number };
  solPrice: { failures: number; missing: number };
  clientErrors: { total: number; byWhere: Record<string, number> };
  metrics: ChartHealthMetric[];
}

/** Below this many candle answers in the window, the null share isn't judged (one null is 100%). */
export const CANDLE_SHARE_MIN_ANSWERS = 20;
/** Null or stale candle answers: amber from this share, red (and the alert) from the next. */
const CANDLE_SHARE_WARN = 0.1;
export const CANDLE_SHARE_ALERT = 0.3;
/**
 * Answers short of the coin's history: amber from this share. Never red: non-Pump.fun coins only
 * ever have the stream's candles, and the chart fills the rest from its backup.
 */
const PARTIAL_SHARE_WARN = 0.3;
/** The chart socket silent this long is red, and alerts. */
export const STREAM_STALL_ALERT_MS = 2 * MINUTE_MS;

/** [amber from, red from] per counted metric in the window. */
const LIMITS: Record<string, [number, number, string]> = {
  reconnects: [2, 5, "Chart socket reconnects"],
  stalls: [1, 3, "Chart socket stalls (silent past its limit)"],
  mismatches: [3, 20, "Covered accounts the stream had missed (RPC check)"],
  heliusFailures: [5, 30, "Curve and pool reads Helius didn't answer"],
  backupFailures: [1, 10, "Curve and pool reads both RPC routes failed"],
  pumpThrottled: [1, 3, "Pump.fun 429s (each pauses every chart's candles 30 s)"],
  pumpHeldBack: [10, 60, "Pump.fun reads held back by our own budget"],
  solPriceFailures: [1, 5, "SOL or quote price reads where every source failed"],
  clientErrors: [5, 50, "Error reports from browsers"],
};

function toneOf(n: number, [warn, bad]: [number, number, string]): HealthTone {
  return n >= bad ? "bad" : n >= warn ? "warn" : "ok";
}

const worst = (tones: HealthTone[]): HealthTone =>
  tones.includes("bad") ? "bad" : tones.includes("warn") ? "warn" : "ok";

/** A free-text label kept short and to a bounded set of names. */
function label(counts: RollingCounts, prefix: string, raw: string): string {
  const clean = raw.replace(/[^\w./:@ -]/g, "").slice(0, 80) || "unknown";
  const names = counts.names(prefix);
  if (names.includes(prefix + clean) || names.length < MAX_LABELS) return clean;
  return "other";
}

export class ChartHealth {
  private readonly counts = new RollingCounts();
  private startedAt: number;
  /** The chart socket's current stall (ms silent), as liveCurve.ts last saw it. */
  private stalledForMs = 0;

  constructor(
    private readonly now: () => number = Date.now,
    /** The process's Pump.fun gate counts, taken (tests stub it). */
    private readonly takePump: () => Record<string, number> = takePumpFunGateStats,
  ) {
    this.startedAt = now();
  }

  private add(name: string, n = 1): void {
    this.counts.add(name, n, this.now());
  }

  /**
   * One candle answer of the chart routes. `feed`: which one ("chart", "fine", "quarter"...);
   * `source`: where its candles came from ("pumpfun", "scan"...), null when it had none; `stale`:
   * served from an expired entry because the refresh failed; `partial`: candles short of the
   * coin's history (the stream's alone, or starting well after the launch).
   */
  recordCandleAnswer(feed: string, source: string | null, stale = false, partial = false): void {
    this.add("candles.answers");
    const f = feed.replace(/[^\w-]/g, "").slice(0, 20) || "chart";
    if (source === null) this.add("candles.null");
    else this.add(`candles.source.${label(this.counts, "candles.source.", `${f}/${source}`)}`);
    if (stale) this.add("candles.stale");
    if (partial) this.add("candles.partial");
  }

  /** One live tail answer, by its source ("stream", "rpc", "pending", "none"). */
  recordLiveTailAnswer(source: string): void {
    this.add("liveTail.answers");
    this.add(`liveTail.source.${label(this.counts, "liveTail.source.", source)}`);
  }

  recordStreamReconnects(n: number): void {
    this.add("stream.reconnects", n);
  }

  /**
   * The chart socket's stall now: ms silent past its limit, 0 while it speaks. A new stall is
   * counted once, when it starts.
   */
  recordStreamStall(stalledForMs: number): void {
    if (stalledForMs > 0 && this.stalledForMs === 0) this.add("stream.stalls");
    this.stalledForMs = stalledForMs;
  }

  recordAccountsVerified(n: number): void {
    this.add("stream.verified", n);
  }

  recordAccountMismatch(kind: "curve" | "pool"): void {
    this.add("stream.mismatches");
    this.add(`stream.mismatches.${kind}`);
  }

  /** Curve and pool reads Helius gave no answer for (`n` accounts), and how the backup route did. */
  recordHeliusReadFailures(n: number): void {
    this.add("rpc.heliusFailures", n);
  }

  recordBackupRead(failed: number, read: number): void {
    this.add("rpc.backupReads", read);
    this.add("rpc.backupFailures", failed);
  }

  /** Every source for SOL's (or a quote coin's) USD price failed. */
  recordSolPriceFailure(): void {
    this.add("solPrice.failures");
  }

  /** A live tail answer held back for want of a USD price. */
  recordUsdMissing(): void {
    this.add("solPrice.missing");
  }

  recordClientError(where: string): void {
    this.add("clientErrors.total");
    this.add(`clientErrors.where.${label(this.counts, "clientErrors.where.", where)}`);
  }

  /** Folds Pump.fun's gate counts for this process in (the API never read them before). */
  takePumpFunGate(): void {
    try {
      const s = this.takePump();
      this.add("pump.requests", (s.swapRequests ?? 0) + (s.frontendRequests ?? 0));
      this.add("pump.throttled", (s.swapThrottled ?? 0) + (s.frontendThrottled ?? 0));
      this.add("pump.heldBack", (s.swapHeldBack ?? 0) + (s.frontendHeldBack ?? 0));
    } catch (err) {
      logger.warn("pump.fun gate stats unread", { error: String(err) });
    }
  }

  snapshot(): ChartHealthSnapshot {
    const now = this.now();
    this.takePumpFunGate();
    const w = this.counts.window(CHART_HEALTH_WINDOW_MS, now);
    const get = (k: string) => w.get(k) ?? 0;
    const byPrefix = (prefix: string) =>
      Object.fromEntries(
        [...w].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v]),
      );
    const answers = get("candles.answers");
    const nullOrStale = get("candles.null") + get("candles.stale");
    const share = answers >= CANDLE_SHARE_MIN_ANSWERS ? nullOrStale / answers : null;
    const shareTone: HealthTone =
      share === null
        ? "ok"
        : share >= CANDLE_SHARE_ALERT
          ? "bad"
          : share >= CANDLE_SHARE_WARN
            ? "warn"
            : "ok";
    const partialShare = answers >= CANDLE_SHARE_MIN_ANSWERS ? get("candles.partial") / answers : null;
    const stallTone: HealthTone =
      this.stalledForMs >= STREAM_STALL_ALERT_MS ? "bad" : this.stalledForMs > 0 ? "warn" : "ok";
    const counted: [string, string, string][] = [
      ["reconnects", "stream.reconnects", "reconnects"],
      ["stalls", "stream.stalls", "stalls"],
      ["mismatches", "stream.mismatches", "mismatches"],
      ["heliusFailures", "rpc.heliusFailures", "heliusFailures"],
      ["backupFailures", "rpc.backupFailures", "backupFailures"],
      ["pumpThrottled", "pump.throttled", "pumpThrottled"],
      ["pumpHeldBack", "pump.heldBack", "pumpHeldBack"],
      ["solPriceFailures", "solPrice.failures", "solPriceFailures"],
      ["clientErrors", "clientErrors.total", "clientErrors"],
    ];
    const metrics: ChartHealthMetric[] = [
      {
        key: "candlesNullOrStale",
        label: "Candle answers null or stale",
        window: nullOrStale,
        sinceBoot: this.counts.total("candles.null") + this.counts.total("candles.stale"),
        tone: shareTone,
        threshold: `amber from ${CANDLE_SHARE_WARN * 100}%, red from ${CANDLE_SHARE_ALERT * 100}% of answers (at least ${CANDLE_SHARE_MIN_ANSWERS})`,
      },
      {
        key: "candlesPartial",
        label: "Candle answers short of the coin's history (stream only, or starting well after launch)",
        window: get("candles.partial"),
        sinceBoot: this.counts.total("candles.partial"),
        tone: partialShare !== null && partialShare >= PARTIAL_SHARE_WARN ? "warn" : "ok",
        threshold: `amber from ${PARTIAL_SHARE_WARN * 100}% of answers (at least ${CANDLE_SHARE_MIN_ANSWERS}); never red`,
      },
      {
        key: "streamStalled",
        label: "Chart socket silent now (s)",
        window: Math.round(this.stalledForMs / 1000),
        sinceBoot: this.counts.total("stream.stalls"),
        tone: stallTone,
        threshold: `amber while stalled, red past ${STREAM_STALL_ALERT_MS / 60_000} min`,
      },
      ...counted.map(([key, name, limit]) => {
        const l = LIMITS[limit]!;
        return {
          key,
          label: l[2],
          window: get(name),
          sinceBoot: this.counts.total(name),
          tone: toneOf(get(name), l),
          threshold: `amber from ${l[0]}, red from ${l[1]} in 5 min`,
        };
      }),
    ];
    return {
      windowMs: CHART_HEALTH_WINDOW_MS,
      since: new Date(this.startedAt).toISOString(),
      status: worst(metrics.map((m) => m.tone)),
      candles: {
        answers,
        bySource: byPrefix("candles.source."),
        null: get("candles.null"),
        stale: get("candles.stale"),
        partial: get("candles.partial"),
        nullOrStaleShare: share === null ? null : Math.round(share * 1000) / 1000,
      },
      liveTail: { answers: get("liveTail.answers"), bySource: byPrefix("liveTail.source.") },
      stream: {
        stalledForMs: this.stalledForMs,
        reconnects: get("stream.reconnects"),
        stalls: get("stream.stalls"),
        verified: get("stream.verified"),
        mismatches: get("stream.mismatches"),
      },
      rpc: {
        heliusFailures: get("rpc.heliusFailures"),
        backupReads: get("rpc.backupReads"),
        backupFailures: get("rpc.backupFailures"),
      },
      pumpFunGate: {
        requests: get("pump.requests"),
        throttled: get("pump.throttled"),
        heldBack: get("pump.heldBack"),
      },
      solPrice: { failures: get("solPrice.failures"), missing: get("solPrice.missing") },
      clientErrors: { total: get("clientErrors.total"), byWhere: byPrefix("clientErrors.where.") },
      metrics,
    };
  }

  /** Test hook. */
  reset(): void {
    this.counts.clear();
    this.stalledForMs = 0;
    this.startedAt = this.now();
  }
}

let shared = new ChartHealth();

/** The process's chart health. */
export function chartHealth(): ChartHealth {
  return shared;
}

/** Tests set their own (with a clock). */
export function setChartHealth(health: ChartHealth): void {
  shared = health;
}

/*
 * The counters the chart routes call (routes/tokens.ts, routes/utilities.ts, tokenChart.ts,
 * solPrice.ts), as plain functions so a call site is one line.
 */

/** One candle answer: `feed` "chart" | "fine" | "quarter"...; `source` null for no candles. */
export function recordCandleAnswer(
  feed: string,
  source: string | null,
  stale = false,
  partial = false,
): void {
  shared.recordCandleAnswer(feed, source, stale, partial);
}

/** Every source for SOL's (or a quote coin's) USD price failed (solPrice.ts). */
export function recordSolPriceFailure(): void {
  shared.recordSolPriceFailure();
}

/** One live tail answer by source (liveCurve.ts calls it on every answer). */
export function recordLiveTailAnswer(source: string): void {
  shared.recordLiveTailAnswer(source);
}

/** /health's nested view: never throws, so /health never fails on it. */
export function chartHealthForHealth(): ChartHealthSnapshot | { error: string } {
  try {
    return shared.snapshot();
  } catch (err) {
    return { error: String(err) };
  }
}

/** A problem worth a Telegram message to the admins. */
interface AlertProblem {
  key: string;
  text: string;
}

/** The problems a snapshot shows that warrant waking someone: charts blank or frozen for many. */
export function chartAlertProblems(s: ChartHealthSnapshot): AlertProblem[] {
  const out: AlertProblem[] = [];
  const share = s.candles.nullOrStaleShare;
  if (share !== null && share >= CANDLE_SHARE_ALERT)
    out.push({
      key: "candles",
      text: `${Math.round(share * 100)}% of chart candle answers in the last 5 minutes were empty or stale (${s.candles.null} null, ${s.candles.stale} stale of ${s.candles.answers}).`,
    });
  if (s.stream.stalledForMs >= STREAM_STALL_ALERT_MS)
    out.push({
      key: "stream",
      text: `The chart socket has been silent for ${Math.round(s.stream.stalledForMs / 60_000)} min: live tails are on RPC reads.`,
    });
  return out;
}

/** How long a problem must have been gone before it counts as cleared (as #804's credits-out alert). */
export const ALERT_CLEAR_GRACE_MS = 2 * MINUTE_MS;
/** How often the alert looks. */
const ALERT_EVERY_MS = MINUTE_MS;

/**
 * Starts and clears problems with flap protection: a problem is told once when it starts, and its
 * clearing only once it has stayed away ALERT_CLEAR_GRACE_MS (a share hovering at the line, or a
 * socket that stalls on and off, would otherwise message every minute). Visible for tests.
 */
export class ChartAlerts {
  /** Open problems: key to when it was last seen. */
  private readonly open = new Map<string, number>();

  constructor(
    private readonly notify: (html: string) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  async check(snapshot: ChartHealthSnapshot): Promise<void> {
    const now = this.now();
    const problems = chartAlertProblems(snapshot);
    const started = problems.filter((p) => !this.open.has(p.key));
    for (const p of problems) this.open.set(p.key, now);
    const cleared: string[] = [];
    for (const [key, seenAt] of this.open) {
      if (problems.some((p) => p.key === key) || now - seenAt < ALERT_CLEAR_GRACE_MS) continue;
      this.open.delete(key);
      cleared.push(key);
    }
    if (started.length === 0 && cleared.length === 0) return;
    const lines: string[] = [];
    if (started.length > 0) {
      lines.push("<b>⚠️ TrenchScanner charts need a look</b>");
      for (const p of started) lines.push(`• ${escapeHtml(p.text)}`);
    }
    if (cleared.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push(`<b>✅ Charts recovered:</b> ${escapeHtml(cleared.join(", "))}`);
    }
    try {
      await this.notify(lines.join("\n"));
    } catch (err) {
      logger.warn("chart alert not sent", { error: String(err) });
    }
  }
}

/** Checks the process's chart health every minute and tells the admins (server.ts). */
export function startChartAlerts(notify: (html: string) => Promise<void>): () => void {
  const alerts = new ChartAlerts(notify);
  const timer = setInterval(() => void alerts.check(shared.snapshot()), ALERT_EVERY_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
