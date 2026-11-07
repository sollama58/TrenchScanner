import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FDSA_DEFAULT_EXIT_PLAN, prisma } from "@trenchscanner/core";
import { exitLabMeta, loadLabTrades, runFdsaExitLabJob } from "./fdsaExitLabJob.js";
import { packPath, type PathSecond } from "./pricePathRecorder.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
if (!dbAvailable && process.env.REQUIRE_TEST_DB === "1")
  throw new Error("REQUIRE_TEST_DB=1 but Postgres is unreachable");

const TAG = `exitlab-${Date.now()}`;
const NOW = new Date("2026-11-07T12:00:00Z");

/** A coin that pops to 1.6x over a minute, then bleeds to 0.3x. */
function popAndDie(): PathSecond[] {
  const rows: PathSecond[] = [];
  for (let sec = 0; sec <= 600; sec += 5) {
    const rel = sec <= 120 ? 1 + (0.6 * sec) / 120 : Math.max(0.3, 1.6 - ((sec - 120) / 300) * 1.3);
    rows.push({ sec, price: 1e-6 * rel, netSol: 0, changes: 1 });
  }
  return rows;
}

async function coin(i: number, opts: { path: boolean; shortlist?: boolean; plan?: boolean }) {
  const token = await prisma.token.create({ data: { mintAddress: `${TAG}-${i}`, symbol: `C${i}` } });
  // The path starts a minute before the alert, so it covers it.
  const alertAt = new Date(NOW.getTime() - (i + 1) * 3_600_000);
  const startAt = new Date(alertAt.getTime() - 60_000);
  const alert = await prisma.curatedAlert.create({
    data: {
      tokenId: token.id,
      source: "cm_test",
      confidence: 50,
      anchorPriceUsd: 1e-6,
      anchorMcapUsd: 10_000,
      createdAt: alertAt,
    },
  });
  // A later alert on the same coin: the lab replays from the first.
  await prisma.curatedAlert.create({
    data: {
      tokenId: token.id,
      source: "cm_test",
      confidence: 50,
      anchorPriceUsd: 1e-6,
      anchorMcapUsd: 10_000,
      createdAt: new Date(alertAt.getTime() + 300_000),
    },
  });
  if (opts.path) {
    const rows = popAndDie();
    const data = packPath(rows);
    await prisma.pricePathRecord.create({
      data: {
        mint: token.mintAddress,
        startAt,
        endAt: new Date(startAt.getTime() + 600_000),
        seconds: rows.length,
        bytes: data.length,
        reason: "aged",
        data,
      },
    });
  }
  if (opts.shortlist || opts.plan) {
    await prisma.fdsaReview.create({
      data: {
        tokenId: token.id,
        curatedAlertId: alert.id,
        stage: opts.plan ? "decide" : "screen",
        model: "test",
        effort: "none",
        promptVersion: "test",
        latencyMs: 0,
        alertAt: alert.createdAt,
        anchorPriceUsd: 1e-6,
        anchorMcapUsd: 10_000,
        decision: opts.plan ? "trade" : "shortlist",
        exitPlan: opts.plan ? FDSA_DEFAULT_EXIT_PLAN : undefined,
      },
    });
  }
  return { token, alert };
}

describe.skipIf(!dbAvailable)("fdsa exit lab job", () => {
  beforeAll(async () => {
    for (let i = 0; i < 40; i++) await coin(i, { path: i < 36, shortlist: i % 3 === 0, plan: i === 1 });
  });
  afterAll(async () => {
    await prisma.pricePathRecord.deleteMany({ where: { mint: { startsWith: TAG } } });
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.$disconnect();
  });

  it("loads each coin's first alert with the path covering it", async () => {
    const { trades } = await loadLabTrades(NOW);
    const ours = trades.filter((t) => t.mint.startsWith(TAG));
    expect(ours).toHaveLength(36);
    const first = ours.find((t) => t.mint === `${TAG}-0`)!;
    expect(first.alertAt.toISOString()).toBe(new Date(NOW.getTime() - 3_600_000).toISOString());
    // The path started 60 s before the alert: replay starts at the alert's own price.
    expect(first.points[0]).toEqual({ sec: 0, rel: 1 });
    expect(first.shortlisted).toBe(true);
    expect(ours.find((t) => t.mint === `${TAG}-1`)!.claudePlan).toEqual(FDSA_DEFAULT_EXIT_PLAN);
  });

  it("reports the tuned plan, the baselines and Claude's plans as heartbeat meta", async () => {
    const meta = await runFdsaExitLabJob(NOW);
    expect(meta.plansTried).toBe(972);
    expect(meta.auditTrailTest).toBeTruthy();
    expect(meta.auditTakeTest).toBeTruthy();
    expect(typeof meta.tunedPlan).toBe("string");
    const tuned = meta.tunedTest as Record<string, number>;
    const fdsaDefault = meta.fdsaDefaultTest as Record<string, number>;
    // On coins that pop and die, the tuned plan banks something the default (waiting for 2x) can't.
    expect(tuned.meanReturnPct!).toBeGreaterThan(fdsaDefault.meanReturnPct!);
    expect(meta.claudePlans).not.toBeNull();
    expect(meta.fdsaDefaultTestEverySecond).toBeTruthy();
  });

  it("flattens to one level of nesting", async () => {
    const { trades } = await loadLabTrades(NOW);
    const { runExitLab } = await import("@trenchscanner/core");
    const meta = exitLabMeta(await runExitLab(trades), 0);
    for (const v of Object.values(meta)) {
      if (v && typeof v === "object")
        for (const w of Object.values(v)) expect(typeof w === "object" && w !== null).toBe(false);
    }
  });
});
