import { prisma, type Env } from "@trenchscanner/core";

/**
 * The Helius plan against what this deployment spends (audit 2026-10-22, H3). The credits ran out
 * on 2026-10-22 with nothing having said they would: every process counts its Helius credits into
 * ApiUsage, but nothing compared them with a plan, and the 30-day projection lived only on the admin
 * panel. With HELIUS_MONTHLY_CREDITS set, pipeline-watch runs this about once an hour and the
 * admins hear once a cycle at each of HELIUS_BUDGET_THRESHOLDS percent used, and once when the last
 * day's rate would run the plan out before the cycle ends.
 *
 * ApiUsage keeps 8 days, less than a cycle, so the cycle's total is carried on pipeline-watch's own
 * heartbeat (this state) and each check adds the buckets since the last. The first check of a cycle
 * counts what ApiUsage still holds of it; `countedSince` says from when, so a total that starts late
 * reads as one.
 */

const DAY_MS = 86_400_000;
/** ApiUsage's bucket (apiUsage.ts). */
const BUCKET_MS = 5 * 60_000;
/** Buckets this recent may still be flushed into (every process flushes once a minute): not read yet. */
const FLUSH_LAG_MS = 3 * 60_000;
/** How often the sums are read: they move over days, and a warning a day ahead loses nothing to an hour. */
export const HELIUS_BUDGET_CHECK_MS = 60 * 60_000;
/** Percent of the plan used at which the admins hear, once each a cycle. */
export const HELIUS_BUDGET_THRESHOLDS = [75, 90, 97] as const;

/** A type, not an interface, so it fits the heartbeat meta (JobRunMeta) as it is. */
export type HeliusPlanState = {
  planCredits: number;
  cycleStart: string;
  cycleEnd: string;
  /** The first bucket counted: later than cycleStart when ApiUsage didn't reach back that far. */
  countedSince: string;
  /** Credits counted this cycle, up to `through` (a bucket boundary). */
  cycleCredits: number;
  through: string;
  last24h: number;
  /** This cycle's credits if the last day's rate holds to its end. */
  projectedCycle: number;
  /** When the plan runs out at the last day's rate; null at no spend. */
  projectedRunOutAt: string | null;
  /** What the admins were told this cycle, comma-separated: thresholds, and "runout". */
  notified: string;
  checkedAt: string;
};

/** The billing cycle `now` falls in, starting on `startDay` (a short month's last day past its end). */
export function heliusCycle(now: number, startDay: number): { start: number; end: number } {
  const at = (y: number, m: number) => {
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return Date.UTC(y, m, Math.min(startDay, last));
  };
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return at(y, m) <= now ? { start: at(y, m), end: at(y, m + 1) } : { start: at(y, m - 1), end: at(y, m) };
}

/** Pure: the projection from the cycle's total so far and the last day's spend. */
export function projectPlan(
  planCredits: number,
  cycleCredits: number,
  last24h: number,
  now: number,
  cycleEnd: number,
): { projectedCycle: number; projectedRunOutAt: number | null } {
  const daysLeft = Math.max(0, cycleEnd - now) / DAY_MS;
  const left = planCredits - cycleCredits;
  return {
    projectedCycle: Math.round(cycleCredits + last24h * daysLeft),
    projectedRunOutAt: left <= 0 ? now : last24h > 0 ? Math.round(now + (left / last24h) * DAY_MS) : null,
  };
}

const short = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(n);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const minute = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

/** Pure: the notices `state` owes the admins, and what it has told them once they're sent. */
export function planNotices(state: HeliusPlanState): { notices: string[]; notified: string } {
  const notified = state.notified.split(",").filter(Boolean);
  const used = (state.cycleCredits / state.planCredits) * 100;
  const end = Date.parse(state.cycleEnd);
  const runOut = state.projectedRunOutAt === null ? null : Date.parse(state.projectedRunOutAt);
  const crossed = HELIUS_BUDGET_THRESHOLDS.filter((t) => used >= t && !notified.includes(String(t)));
  const runsOut = runOut !== null && runOut < end && !notified.includes("runout");
  if (crossed.length === 0 && !runsOut) return { notices: [], notified: state.notified };
  const lines: string[] = [];
  const top = crossed.length > 0 ? crossed[crossed.length - 1] : null;
  lines.push(
    top !== null
      ? `<b>⚠️ Helius credits: ${top}% of the plan used</b>`
      : "<b>⚠️ Helius credits will run out before the cycle ends</b>",
  );
  lines.push(
    `• ${short(state.cycleCredits)} of ${short(state.planCredits)} this cycle ` +
      `(counted since ${day(Date.parse(state.countedSince))}; the cycle ends ${day(end)})`,
  );
  lines.push(`• Last 24 h: ${short(state.last24h)}; projected for the cycle: ${short(state.projectedCycle)}`);
  if (runOut !== null && runOut < end) lines.push(`• At that rate the plan runs out ${minute(runOut)} UTC`);
  for (const t of crossed) notified.push(String(t));
  if (runsOut) notified.push("runout");
  return { notices: [lines.join("\n")], notified: notified.join(",") };
}

async function heliusCredits(from: number, to: number): Promise<number> {
  if (to <= from) return 0;
  const sum = await prisma.apiUsage.aggregate({
    _sum: { credits: true },
    where: { provider: "helius", bucket: { gte: new Date(from), lt: new Date(to) } },
  });
  return sum._sum.credits ?? 0;
}

/**
 * The plan's state after this check, and the notices it owes; `prev` back unchanged within
 * HELIUS_BUDGET_CHECK_MS of the last check. Null with HELIUS_MONTHLY_CREDITS unset.
 */
export async function checkHeliusPlan(
  env: Pick<Env, "HELIUS_MONTHLY_CREDITS" | "HELIUS_CYCLE_START_DAY">,
  prev: HeliusPlanState | null,
  now: number,
): Promise<{ state: HeliusPlanState | null; notices: string[] }> {
  const plan = env.HELIUS_MONTHLY_CREDITS;
  if (!plan) return { state: null, notices: [] };
  const cycle = heliusCycle(now, env.HELIUS_CYCLE_START_DAY);
  const cycleStart = new Date(cycle.start).toISOString();
  const sameCycle = prev !== null && prev.cycleStart === cycleStart && prev.planCredits === plan;
  if (sameCycle && now - Date.parse(prev.checkedAt) < HELIUS_BUDGET_CHECK_MS)
    return { state: prev, notices: [] };

  const through = Math.floor((now - FLUSH_LAG_MS) / BUCKET_MS) * BUCKET_MS;
  let cycleCredits: number;
  let countedSince: string;
  if (sameCycle) {
    cycleCredits = prev.cycleCredits + (await heliusCredits(Date.parse(prev.through), through));
    countedSince = prev.countedSince;
  } else {
    cycleCredits = await heliusCredits(cycle.start, through);
    const first = await prisma.apiUsage.aggregate({
      _min: { bucket: true },
      where: { provider: "helius", bucket: { gte: new Date(cycle.start) } },
    });
    countedSince = (first._min.bucket ?? new Date(cycle.start)).toISOString();
  }
  const last24h = await heliusCredits(through - DAY_MS, through);
  const { projectedCycle, projectedRunOutAt } = projectPlan(plan, cycleCredits, last24h, now, cycle.end);
  const state: HeliusPlanState = {
    planCredits: plan,
    cycleStart,
    cycleEnd: new Date(cycle.end).toISOString(),
    countedSince,
    cycleCredits,
    through: new Date(Math.max(through, sameCycle ? Date.parse(prev.through) : through)).toISOString(),
    last24h,
    projectedCycle,
    projectedRunOutAt: projectedRunOutAt === null ? null : new Date(projectedRunOutAt).toISOString(),
    notified: sameCycle ? prev.notified : "",
    checkedAt: new Date(now).toISOString(),
  };
  const { notices, notified } = planNotices(state);
  return { state: { ...state, notified }, notices };
}

/** The state as pipeline-watch's heartbeat stored it, or null. */
export function readPlanState(meta: unknown): HeliusPlanState | null {
  if (typeof meta !== "object" || meta === null) return null;
  const s = meta as Partial<HeliusPlanState>;
  if (
    typeof s.planCredits !== "number" ||
    typeof s.cycleStart !== "string" ||
    typeof s.through !== "string" ||
    typeof s.cycleCredits !== "number" ||
    typeof s.checkedAt !== "string"
  ) {
    return null;
  }
  return { ...(s as HeliusPlanState), notified: typeof s.notified === "string" ? s.notified : "" };
}
