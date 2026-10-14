import { PerformanceObserver, constants as perfConstants } from "node:perf_hooks";
import { createLogger } from "./logger.js";

const logger = createLogger("event-loop");

/** How often the watch ticks. Its lateness is how long the loop was held. */
const TICK_MS = 500;
/** Lateness worth a log line: below this a busy moment, above it every timer in the process waits. */
export const LOOP_STALL_LOG_MS = 3_000;
/** A single garbage collection this long is logged on its own, so a stall can be told apart from GC. */
const GC_PAUSE_LOG_MS = 1_000;

/** What the process holds, in MB, so a stall line says whether memory was the pressure. */
function memoryMb(): Record<string, number> {
  const m = process.memoryUsage();
  const mb = (n: number) => Math.round(n / 1_048_576);
  return {
    rssMb: mb(m.rss),
    heapUsedMb: mb(m.heapUsed),
    heapTotalMb: mb(m.heapTotal),
    externalMb: mb(m.external),
  };
}

export interface LoopStall {
  at: string;
  blockedMs: number;
  /** What was running when the loop came back (from `context`), e.g. the jobs in flight. */
  during: unknown;
  /** Garbage collection inside the stall, in ms: most of blockedMs means memory, little means code. */
  gcMs: number;
}

export interface LoopWatchReport {
  /** Stalls of LOOP_STALL_LOG_MS or more since the process started. */
  stalls: number;
  worst: LoopStall | null;
  last: LoopStall | null;
}

const report: LoopWatchReport = { stalls: 0, worst: null, last: null };
let gcMsTotal = 0;
let stopWatch: (() => void) | null = null;

/**
 * Logs every time this process's event loop is held for LOOP_STALL_LOG_MS or more, with what was
 * running, how much of it was garbage collection, and the process's memory.
 *
 * Why: on 2026-10-14 the scanner went silent for most of a minute and then logged Jupiter and
 * Helius timeouts in the same millisecond - every timer in the process had expired while
 * something held the loop, so the providers got the blame for a stall inside the process. Nothing
 * said what held it. Started once per process; calling it again is a no-op.
 */
export function startEventLoopWatch(
  opts: { context?: () => unknown; stallMs?: number; tickMs?: number } = {},
): () => void {
  const stallMs = opts.stallMs ?? LOOP_STALL_LOG_MS;
  const tickMs = opts.tickMs ?? TICK_MS;
  if (stopWatch) return stopWatch;
  let gcObserver: PerformanceObserver | null = null;
  try {
    gcObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        gcMsTotal += entry.duration;
        if (entry.duration >= GC_PAUSE_LOG_MS) {
          const detail = (entry as unknown as { detail?: { kind?: number } }).detail;
          logger.warn("long garbage collection pause", {
            pauseMs: Math.round(entry.duration),
            major: detail?.kind === perfConstants.NODE_PERFORMANCE_GC_MAJOR,
            ...memoryMb(),
          });
        }
      }
    });
    gcObserver.observe({ entryTypes: ["gc"] });
  } catch {
    // GC entries are diagnostics only; the stall watch below works without them.
  }

  let expected = Date.now() + tickMs;
  let gcAtTick = gcMsTotal;
  const timer = setInterval(() => {
    const now = Date.now();
    const blockedMs = now - expected;
    expected = now + tickMs;
    const gcMs = Math.round(gcMsTotal - gcAtTick);
    gcAtTick = gcMsTotal;
    if (blockedMs < stallMs) return;
    let during: unknown = null;
    try {
      during = opts.context?.() ?? null;
    } catch {
      // Context is best effort; the stall itself still gets logged.
    }
    const stall: LoopStall = { at: new Date(now).toISOString(), blockedMs, during, gcMs };
    report.stalls += 1;
    report.last = stall;
    if (!report.worst || blockedMs > report.worst.blockedMs) report.worst = stall;
    logger.warn("event loop was blocked - every timer and request in this process waited", {
      blockedMs,
      gcMs,
      during,
      ...memoryMb(),
    });
  }, tickMs);
  timer.unref?.();

  stopWatch = () => {
    clearInterval(timer);
    gcObserver?.disconnect();
    stopWatch = null;
  };
  return stopWatch;
}

/** The stalls this process has seen, for a heartbeat or a health route. */
export function eventLoopReport(): LoopWatchReport {
  return { ...report };
}

/** Test hook. */
export function resetEventLoopReport(): void {
  report.stalls = 0;
  report.worst = null;
  report.last = null;
}
