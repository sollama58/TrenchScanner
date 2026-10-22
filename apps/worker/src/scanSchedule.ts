import type { JobRunMeta, scheduleInterval } from "./scheduler.js";

/**
 * The scan cycle's schedule options: a deadline, the meta a failed run keeps, and no early runs.
 *
 * Until 2026-10-22 a young launch crossing into the band started the next cycle at once (the band
 * wake, #874, as `runEarly`). Every cycle re-reads the whole band on per-cycle Helius budgets, and
 * with some launch near the floor crossing almost all the time the scan ran about 3.6 times a minute
 * and spent about 2.1M Helius credits a day (notes/audit-2026-10-22, C1). The crossing coin now gets
 * its own first scan from the entry fast path (entryFastPath.ts), and the cycle keeps its minute
 * (user decision 2026-10-22). Its own module so the scheduler's tests can hold it to that.
 */
export function scanScheduleOptions(failureMeta: () => JobRunMeta): Parameters<typeof scheduleInterval>[3] {
  return { deadlineMinutes: 20, failureMeta };
}
