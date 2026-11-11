import { prisma } from "../db.js";
import { wilsonLowerBound } from "../wilson.js";
import { MEMBER_MIN_EXAM_LIFT } from "./combinerMembers.js";
import type { ContestantSpec } from "./contestants.js";

/**
 * The pass mark for calling live: a seat whose own record says it adds nothing over the market
 * goes tracking-only on its own, and comes back once its record clears again.
 *
 * Until 2026-11-11 a seat stopped calling only when its spec was hand-set tracking-only
 * (ContestantSpec.trackingOnly: Safe and Return Regression, #1072). The full audit of 2026-10-27
 * (MT-2) found four seats calling live with a 7-day lift lower bound at or under the market
 * (Narrative 0.46, Gems 0.85, Profit Factor 0.99, Order Flow 1.05). The user kept them calling and
 * asked for a re-measure; on 2026-11-10 three had recovered (1.21-1.52) and Narrative was still
 * under the market but on too few calls to judge (notes/seat-pass-mark-2026-11-10). The user then
 * chose the automatic rule over hand-setting a seat (decision 2026-11-11).
 *
 * The rule (the audit's option a): a seat is benched when
 *  - its live lift lower bound (the Wilson 95% lower bound of its 2x rate over the market's 2x
 *    rate) is under PASS_MARK_MIN_LIVE_LIFT on at least PASS_MARK_MIN_GRADED graded calls in the
 *    last PASS_MARK_WINDOW_HOURS, or
 *  - its exam 2x rate is under MEMBER_MIN_EXAM_LIFT times the exam's reference rows' 2x rate (the
 *    same line that keeps a weak seat out of the voting combiners).
 * It calls again when neither holds.
 *
 * "Its calls" are the decision moments where the seat's score cleared its own cutoff
 * (CandidateOutcome.seatCalls), not its alerts: a benched seat sends nothing, so an alert record
 * could never clear it again. Both sides are graded "event" rows (the market is every graded one),
 * so the lift compares the same population. A benched seat still scores and is banked, so the
 * combiners that read it are unchanged.
 */

/** The live window the pass mark reads: seven days, the audit's window. */
export const PASS_MARK_WINDOW_HOURS = 168;
/** A seat is judged on its live record only from this many graded calls in the window. */
export const PASS_MARK_MIN_GRADED = 300;
/** The live lift lower bound a seat must hold to keep calling. */
export const PASS_MARK_MIN_LIVE_LIFT = 1.1;
/** The z of the Wilson bound on a seat's live 2x rate (95%, as the audit's tables). */
export const PASS_MARK_Z = 1.96;

export interface PassMarkInput {
  /** The seat's graded calls in the window, and the clean 2x among them. */
  graded: number;
  wins: number;
  /** Every graded decision moment in the window, and the clean 2x among them. */
  marketGraded: number;
  marketWins: number;
  /** The active model's exam 2x rate (wins / graded), or null without an exam. */
  examWinRate: number | null;
  /** The exam's reference rows' 2x rate, or null when the run didn't store it. */
  examReferenceWinRate: number | null;
}

export interface PassMarkVerdict {
  calling: boolean;
  /** The live lift lower bound, or null with nothing graded or no market. */
  liveLiftLower: number | null;
  /** The exam lift, or null when either side is unknown. */
  examLift: number | null;
  reason: string;
}

const fixed = (x: number) => x.toFixed(2);

export function passMarkVerdict(input: PassMarkInput): PassMarkVerdict {
  const marketRate = input.marketGraded > 0 ? input.marketWins / input.marketGraded : 0;
  const liveLiftLower =
    input.graded > 0 && marketRate > 0
      ? wilsonLowerBound(input.wins, input.graded, PASS_MARK_Z) / marketRate
      : null;
  const examLift =
    input.examWinRate !== null && input.examReferenceWinRate !== null && input.examReferenceWinRate > 0
      ? input.examWinRate / input.examReferenceWinRate
      : null;
  const failures: string[] = [];
  if (
    liveLiftLower !== null &&
    input.graded >= PASS_MARK_MIN_GRADED &&
    liveLiftLower < PASS_MARK_MIN_LIVE_LIFT
  ) {
    failures.push(
      `its live lift lower bound is ${fixed(liveLiftLower)} on ${input.graded} graded calls, under ${PASS_MARK_MIN_LIVE_LIFT}`,
    );
  }
  if (examLift !== null && examLift < MEMBER_MIN_EXAM_LIFT) {
    failures.push(`its exam lift is ${fixed(examLift)}, under ${MEMBER_MIN_EXAM_LIFT}`);
  }
  if (failures.length > 0) {
    return { calling: false, liveLiftLower, examLift, reason: `Tracking only: ${failures.join("; ")}.` };
  }
  const live =
    liveLiftLower === null
      ? "no graded live calls yet"
      : input.graded < PASS_MARK_MIN_GRADED
        ? `${input.graded} graded live calls, under the ${PASS_MARK_MIN_GRADED} it is judged on`
        : `live lift lower bound ${fixed(liveLiftLower)} on ${input.graded} graded calls`;
  const exam = examLift === null ? "no exam lift" : `exam lift ${fixed(examLift)}`;
  return { calling: true, liveLiftLower, examLift, reason: `Calling: ${live}; ${exam}.` };
}

/** The seats the pass mark judges: every calling seat except the hand-set tracking-only and retired ones. */
export function passMarkSeats(roster: readonly ContestantSpec[]): ContestantSpec[] {
  return roster.filter((s) => s.trackingOnly !== true && s.retired !== true);
}

export interface SeatCallRecord {
  graded: number;
  wins: number;
}

/**
 * Each seat's graded would-be calls (CandidateOutcome.seatCalls) and the market over the window
 * ending at `now`. A clean 2x is hit2xIn1h on a row that wasn't disqualified, as everywhere else.
 */
export async function loadPassMarkRecords(
  now: Date,
): Promise<{ seats: Map<string, SeatCallRecord>; market: SeatCallRecord }> {
  const since = new Date(now.getTime() - PASS_MARK_WINDOW_HOURS * 3_600_000);
  const [seatRows, marketRows] = await Promise.all([
    prisma.$queryRaw<{ seat: string; graded: bigint; wins: bigint }[]>`
      SELECT s.seat, count(*) AS graded,
             count(*) FILTER (WHERE co."hit2xIn1h" = true AND co."disqualified" IS NOT TRUE) AS wins
      FROM "CandidateOutcome" co, jsonb_array_elements_text(co."seatCalls") AS s(seat)
      WHERE co."sampleKind" = 'event' AND jsonb_typeof(co."seatCalls") = 'array'
        AND co."anchorAt" > ${since} AND co."anchorAt" <= ${now}
        AND co."hit2xIn1h" IS NOT NULL
      GROUP BY s.seat`,
    // The market: the graded moments the seats decided on since seatCalls is written.
    prisma.$queryRaw<{ graded: bigint; wins: bigint }[]>`
      SELECT count(*) AS graded,
             count(*) FILTER (WHERE "hit2xIn1h" = true AND "disqualified" IS NOT TRUE) AS wins
      FROM "CandidateOutcome"
      WHERE "sampleKind" = 'event' AND "anchorAt" > ${since} AND "anchorAt" <= ${now}
        AND "hit2xIn1h" IS NOT NULL AND "seatCalls" IS NOT NULL`,
  ]);
  const seats = new Map<string, SeatCallRecord>();
  for (const r of seatRows) seats.set(r.seat, { graded: Number(r.graded), wins: Number(r.wins) });
  const m = marketRows[0];
  return { seats, market: { graded: Number(m?.graded ?? 0), wins: Number(m?.wins ?? 0) } };
}

/** The exam side of each seat: its active model's exam record and the run's reference 2x rate. */
export async function loadExamLifts(
  ids: readonly string[],
): Promise<Map<string, { examWinRate: number | null; examReferenceWinRate: number | null }>> {
  const out = new Map<string, { examWinRate: number | null; examReferenceWinRate: number | null }>();
  if (ids.length === 0) return out;
  const rows = await prisma.curatorModel.findMany({
    where: { status: "active", contestant: { in: [...ids] } },
    orderBy: { createdAt: "desc" },
    select: { contestant: true, evalMetrics: true },
  });
  for (const row of rows) {
    if (!row.contestant || out.has(row.contestant)) continue;
    const m = (row.evalMetrics ?? {}) as {
      exam?: { graded?: unknown; wins?: unknown };
      examReferenceWinRate?: unknown;
    };
    const graded = typeof m.exam?.graded === "number" ? m.exam.graded : 0;
    const wins = typeof m.exam?.wins === "number" ? m.exam.wins : 0;
    out.set(row.contestant, {
      examWinRate: graded > 0 ? wins / graded : null,
      examReferenceWinRate: typeof m.examReferenceWinRate === "number" ? m.examReferenceWinRate : null,
    });
  }
  return out;
}

export interface PassMarkRecord {
  contestant: string;
  calling: boolean;
  graded: number;
  wins: number;
  marketGraded: number;
  marketWins: number;
  liveLiftLower: number | null;
  examLift: number | null;
  reason: string;
  judgedAt: Date;
  /** When `calling` last changed (first judged, for a seat never benched). */
  changedAt: Date;
}

/**
 * Judges every seat on the roster and stores the verdicts (CuratorPassMark, one row per seat).
 * Returns the verdicts and the seats whose verdict changed.
 */
export async function rejudgePassMarks(
  roster: readonly ContestantSpec[],
  now = new Date(),
): Promise<{ verdicts: PassMarkRecord[]; changed: string[] }> {
  const seats = passMarkSeats(roster);
  const ids = seats.map((s) => s.id);
  const [records, exams, previous] = await Promise.all([
    loadPassMarkRecords(now),
    loadExamLifts(ids),
    prisma.curatorPassMark.findMany({ where: { contestant: { in: ids } } }),
  ]);
  const before = new Map(previous.map((p) => [p.contestant, p]));
  const verdicts: PassMarkRecord[] = [];
  const changed: string[] = [];
  for (const id of ids) {
    const live = records.seats.get(id) ?? { graded: 0, wins: 0 };
    const exam = exams.get(id) ?? { examWinRate: null, examReferenceWinRate: null };
    const verdict = passMarkVerdict({
      graded: live.graded,
      wins: live.wins,
      marketGraded: records.market.graded,
      marketWins: records.market.wins,
      ...exam,
    });
    const prior = before.get(id);
    const flipped = prior !== undefined && prior.calling !== verdict.calling;
    // A seat seen for the first time while calling isn't a change; one benched at once is.
    if (flipped || (prior === undefined && !verdict.calling)) changed.push(id);
    const data = {
      calling: verdict.calling,
      graded: live.graded,
      wins: live.wins,
      marketGraded: records.market.graded,
      marketWins: records.market.wins,
      liveLiftLower: verdict.liveLiftLower,
      examLift: verdict.examLift,
      reason: verdict.reason,
      judgedAt: now,
      changedAt: prior === undefined || flipped ? now : prior.changedAt,
    };
    await prisma.curatorPassMark.upsert({
      where: { contestant: id },
      create: { contestant: id, ...data },
      update: data,
    });
    verdicts.push({ contestant: id, ...data });
  }
  return { verdicts, changed };
}

/** The seats the pass mark has benched: they score and bank as before, but send nothing. */
export async function loadBenchedSeats(): Promise<Set<string>> {
  const rows = await prisma.curatorPassMark.findMany({
    where: { calling: false },
    select: { contestant: true },
  });
  return new Set(rows.map((r) => r.contestant));
}

/** The roster with each benched seat marked tracking-only, for the readers that only ask "does it call". */
export function withPassMark(
  roster: readonly ContestantSpec[],
  benched: ReadonlySet<string>,
): ContestantSpec[] {
  return roster.map((s) => (benched.has(s.id) && s.trackingOnly !== true ? { ...s, trackingOnly: true } : s));
}
