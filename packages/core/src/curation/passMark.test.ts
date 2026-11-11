import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../db.js";
import type { ContestantSpec } from "./contestants.js";
import {
  loadBenchedSeats,
  loadPassMarkRecords,
  PASS_MARK_MIN_GRADED,
  passMarkSeats,
  passMarkVerdict,
  rejudgePassMarks,
  withPassMark,
} from "./passMark.js";

const noExam = { examWinRate: null, examReferenceWinRate: null };
// The 2026-10-20..27 market of the full audit (MT-2): 16.4% of 9,511 graded moments.
const market = { marketGraded: 9511, marketWins: 1560 };

describe("passMarkVerdict", () => {
  it("benches a seat whose live lift lower bound is under 1.1 on enough calls (Order Flow, 10-27)", () => {
    const v = passMarkVerdict({ graded: 2879, wins: 533, ...market, ...noExam });
    expect(v.calling).toBe(false);
    expect(v.liveLiftLower).toBeCloseTo(1.05, 1);
    expect(v.reason).toMatch(/live lift lower bound is 1\.0\d on 2879 graded calls/);
  });

  it("keeps a seat that clears it (Agreement, 10-27)", () => {
    const v = passMarkVerdict({ graded: 1771, wins: 416, ...market, ...noExam });
    expect(v.calling).toBe(true);
    expect(v.liveLiftLower).toBeGreaterThan(1.3);
  });

  it("doesn't judge a live record under the call floor (Narrative, 11-10: 2 of 41)", () => {
    const v = passMarkVerdict({ graded: 41, wins: 2, ...market, ...noExam });
    expect(PASS_MARK_MIN_GRADED).toBe(300);
    expect(v.calling).toBe(true);
    expect(v.reason).toMatch(/41 graded live calls, under the 300/);
  });

  it("benches on the exam alone, under the combiners' 1.2 line", () => {
    const v = passMarkVerdict({
      graded: 1771,
      wins: 416,
      ...market,
      examWinRate: 0.179,
      examReferenceWinRate: 0.155,
    });
    expect(v.calling).toBe(false);
    expect(v.examLift).toBeCloseTo(1.15, 2);
    expect(v.reason).toMatch(/exam lift is 1\.15, under 1\.2/);
  });

  it("calls again once both clear", () => {
    const failing = passMarkVerdict({
      graded: 600,
      wins: 100,
      ...market,
      examWinRate: 0.2,
      examReferenceWinRate: 0.15,
    });
    const cleared = passMarkVerdict({
      graded: 600,
      wins: 150,
      ...market,
      examWinRate: 0.2,
      examReferenceWinRate: 0.15,
    });
    expect(failing.calling).toBe(false);
    expect(cleared.calling).toBe(true);
  });

  it("calls with no record at all (nothing graded, no market, no exam)", () => {
    const v = passMarkVerdict({ graded: 0, wins: 0, marketGraded: 0, marketWins: 0, ...noExam });
    expect(v).toMatchObject({ calling: true, liveLiftLower: null, examLift: null });
  });
});

const spec = (id: string, extra: Partial<ContestantSpec> = {}) =>
  ({ id, name: id, ...extra }) as ContestantSpec;

describe("passMarkSeats / withPassMark", () => {
  it("judges calling seats only, and marks the benched ones tracking-only", () => {
    const roster = [
      spec("a"),
      spec("safe", { trackingOnly: true }),
      spec("old", { retired: true }),
      spec("b"),
    ];
    expect(passMarkSeats(roster).map((s) => s.id)).toEqual(["a", "b"]);
    const marked = withPassMark(roster, new Set(["b"]));
    expect(marked.map((s) => s.trackingOnly === true)).toEqual([false, true, false, true]);
    expect(roster[3]!.trackingOnly).toBeUndefined();
  });
});

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `passmark-test-${Date.now()}`;

describe.skipIf(!dbAvailable)("rejudgePassMarks", () => {
  // A week no other test writes in, so the market is exactly the rows below.
  const now = new Date("2031-03-08T00:00:00Z");
  const seats = [`${TAG}-weak`, `${TAG}-strong`, `${TAG}-new`];

  afterAll(async () => {
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.curatorPassMark.deleteMany({ where: { contestant: { startsWith: TAG } } });
  });

  it("reads would-be calls off seatCalls, stores the verdicts and brings a seat back", async () => {
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-mint` } });
    const row = (i: number, win: boolean, seatCalls: string[] | null, extra: object = {}) => ({
      tokenId: token.id,
      anchorAt: new Date(now.getTime() - (i + 1) * 60_000),
      anchorPriceUsd: 1,
      anchorMcapUsd: 10_000,
      sampleKind: "event",
      labelRule: 3,
      features: {},
      nextCheckAt: now,
      peak1hPriceUsd: win ? 2 : 1,
      low1hPriceUsd: 1,
      lowBefore2xPriceUsd: 1,
      peak24hPriceUsd: win ? 2 : 1,
      hit2xIn1h: win,
      disqualified: false,
      ...(seatCalls === null ? {} : { seatCalls }),
      ...extra,
    });
    // 1,000 moments, 15% doubled. Weak calls 400 of them at 15%; strong calls 400 at 30%.
    const data = [];
    for (let i = 0; i < 1000; i++) {
      const win = i < 150;
      const calls: string[] = [];
      if (i >= 100 && i < 500) calls.push(seats[0]!); // 50 of its 400 win: 12.5%
      if (i < 120 || (i >= 600 && i < 880)) calls.push(seats[1]!); // 120 of 400: 30%
      data.push(row(i, win, calls));
    }
    // Not counted: an ungraded moment, an entry row, one before seatCalls was written, one out of the window.
    data.push(row(2000, true, [seats[0]!], { hit2xIn1h: null }));
    data.push(row(2001, true, [seats[0]!], { sampleKind: "entry" }));
    data.push(row(2002, true, null));
    data.push(row(20_000, true, [seats[0]!]));
    await prisma.candidateOutcome.createMany({ data });

    const records = await loadPassMarkRecords(now);
    expect(records.market).toEqual({ graded: 1000, wins: 150 });
    expect(records.seats.get(seats[0]!)).toEqual({ graded: 400, wins: 50 });
    expect(records.seats.get(seats[1]!)).toEqual({ graded: 400, wins: 120 });

    const roster = seats.map((id) => spec(id));
    const first = await rejudgePassMarks(roster, now);
    expect(first.verdicts.map((v) => [v.contestant, v.calling])).toEqual([
      [seats[0], false],
      [seats[1], true],
      [seats[2], true],
    ]);
    expect(first.changed).toEqual([seats[0]]);
    const benched = await loadBenchedSeats();
    expect(benched.has(seats[0]!)).toBe(true);
    expect(benched.has(seats[1]!)).toBe(false);

    // The weak seat's would-be calls keep banking while it is benched; once they clear, it calls again.
    await prisma.candidateOutcome.updateMany({
      where: { tokenId: token.id, sampleKind: "event", hit2xIn1h: true, seatCalls: { equals: [seats[1]!] } },
      data: { seatCalls: [seats[0]!, seats[1]!] },
    });
    const later = new Date(now.getTime() + 60_000);
    const second = await rejudgePassMarks(roster, later);
    expect(second.verdicts.find((v) => v.contestant === seats[0])?.calling).toBe(true);
    expect(second.changed).toEqual([seats[0]]);
    const stored = await prisma.curatorPassMark.findUnique({ where: { contestant: seats[0]! } });
    expect(stored?.changedAt.getTime()).toBe(later.getTime());
    const strong = await prisma.curatorPassMark.findUnique({ where: { contestant: seats[1]! } });
    expect(strong?.changedAt.getTime()).toBe(now.getTime());
  });
});
