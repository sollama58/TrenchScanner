import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../db.js";
import { liveCallRecord, liveCallRecords } from "./laneStore.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `lanestore-test-${Date.now()}`;

/**
 * liveCallRecords answers every seat in one grouped query; liveCallRecord is the per-model
 * original. They must agree, including a seat whose lane was born inside the window.
 */
describe.skipIf(!dbAvailable)("liveCallRecords", () => {
  afterAll(async () => {
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  it("matches the per-model record for every seat", async () => {
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-mint` } });
    const now = Date.now();
    const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000);
    const alert = (model: string, minutesAgo: number, hit2xIn1h: boolean | null, peak = 150) => ({
      tokenId: token.id,
      model: `${TAG}-${model}`,
      source: "test",
      confidence: 0.5,
      anchorPriceUsd: 1,
      anchorMcapUsd: 10_000,
      createdAt: at(minutesAgo),
      hit2xIn1h,
      hit4xIn1h: hit2xIn1h ? peak >= 300 : hit2xIn1h,
      disqualified: hit2xIn1h === null ? null : false,
      peak1hReturnPct: peak,
    });
    await prisma.curatedAlert.createMany({
      data: [
        { ...alert("a", 10, true, 400), simReturnPct: 191 },
        { ...alert("a", 20, false), simReturnPct: -50 },
        alert("a", 30, null),
        alert("b", 5, true),
        alert("b", 50, true), // before b's lane was born - excluded
        // After the takeover, but called under the retired lane's name by a stale roster - excluded.
        { ...alert("b", 3, false), modelName: `${TAG}-b-old` },
        { ...alert("b", 4, null), modelName: `${TAG}-b-new` },
        alert("a", 60 * 24 * 40, true), // outside the window
      ],
    });
    const since = at(60 * 24 * 30);
    const lanes = [{ slot: `${TAG}-b`, name: `${TAG}-b-new`, bornAt: at(40) }] as unknown as Parameters<
      typeof liveCallRecords
    >[2];
    const models = [`${TAG}-a`, `${TAG}-b`, `${TAG}-none`];
    const batched = await liveCallRecords(models, since, lanes);

    expect(batched.get(`${TAG}-a`)).toEqual(await liveCallRecord(`${TAG}-a`, since));
    expect(batched.get(`${TAG}-none`)).toEqual({
      calls: 0,
      graded: 0,
      wins: 0,
      goals: 0,
      sumLabel: 0,
      simCalls: 0,
      sumSimReturnPct: 0,
    });
    expect(batched.get(`${TAG}-a`)).toMatchObject({
      calls: 3,
      graded: 2,
      wins: 1,
      goals: 1,
      simCalls: 2,
      sumSimReturnPct: 141,
    });
    expect(batched.get(`${TAG}-b`)).toEqual({
      calls: 2,
      graded: 1,
      wins: 1,
      goals: 0,
      sumLabel: expect.any(Number),
      simCalls: 0,
      sumSimReturnPct: 0,
    });
  });
});
