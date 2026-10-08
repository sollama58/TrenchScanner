// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, loadEnv, summarizeJudgeRecord, type JudgedCall } from "@trenchscanner/core";
import { settleEvolutionRun, maybeEvolvePlaybook, resetEvolutionBackoff } from "./playbook.js";
import { activePlaybook, resetActivePlaybookCache } from "./playbookStore.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const targets = { winRate: 0.75, goalRate: 0.5, minSupport: 30, confidenceZ: 1 };
const record = (wins: number, buys: number) =>
  summarizeJudgeRecord(
    [
      ...Array.from({ length: buys }, (_, i): JudgedCall => ({
        decision: "buy",
        probability2x: i < wins ? 0.7 : 0.3,
        labelValue: i < wins ? 1.5 : 0,
      })),
      ...Array.from({ length: 40 }, (): JudgedCall => ({
        decision: "no_buy",
        probability2x: 0.1,
        labelValue: 0,
      })),
    ],
    targets,
  );

describe.skipIf(!dbAvailable)("playbook evolution", () => {
  const env = dbAvailable ? loadEnv() : (undefined as never);

  async function clean() {
    await prisma.aiReplayRun.deleteMany({});
    await prisma.aiPlaybook.deleteMany({});
    resetActivePlaybookCache();
    resetEvolutionBackoff();
  }
  beforeEach(clean);
  afterEach(clean);

  async function round() {
    const incumbent = await prisma.aiPlaybook.create({ data: { version: 1, status: "active", text: "" } });
    const a = await prisma.aiPlaybook.create({
      data: { version: 2, status: "candidate", text: "rule a", parentId: incumbent.id },
    });
    const b = await prisma.aiPlaybook.create({
      data: { version: 3, status: "candidate", text: "rule b", parentId: incumbent.id },
    });
    return { incumbent, a, b };
  }

  it("creates an empty first playbook on first use", async () => {
    const first = await activePlaybook();
    expect(first).toMatchObject({ version: 1, text: "" });
  });

  it("promotes the candidate that clearly beat the incumbent, retires the incumbent, rejects the rest", async () => {
    const { incumbent, a, b } = await round();
    await settleEvolutionRun(
      {
        id: "run",
        purpose: "evolution",
        playbookIds: [incumbent.id, a.id, b.id],
        summaries: { [incumbent.id]: record(6, 20), [a.id]: record(9, 20), [b.id]: record(17, 20) },
      },
      env,
    );
    const status = async (id: string) =>
      (await prisma.aiPlaybook.findUniqueOrThrow({ where: { id } })).status;
    expect(await status(incumbent.id)).toBe("retired");
    expect(await status(a.id)).toBe("rejected");
    expect(await status(b.id)).toBe("active");
    expect((await activePlaybook())?.id).toBe(b.id);
  });

  it("keeps the incumbent when no candidate beat it clearly", async () => {
    const { incumbent, a, b } = await round();
    await settleEvolutionRun(
      {
        id: "run",
        purpose: "evolution",
        playbookIds: [incumbent.id, a.id, b.id],
        summaries: { [incumbent.id]: record(12, 20), [a.id]: record(12, 20), [b.id]: record(4, 20) },
      },
      env,
    );
    const rows = await prisma.aiPlaybook.findMany({ orderBy: { version: "asc" } });
    expect(rows.map((r) => r.status)).toEqual(["active", "rejected", "rejected"]);
    expect(rows[0]!.metrics).not.toBeNull();
  });

  it("waits while a replay is running, and when the last round is recent", async () => {
    const on = { ...env, AI_PLAYBOOK_EVOLUTION: true };
    expect(await maybeEvolvePlaybook({ ...env, AI_PLAYBOOK_EVOLUTION: false })).toBe("disabled");
    const run = await prisma.aiReplayRun.create({
      data: {
        purpose: "evolution",
        status: "submitted",
        model: "m",
        playbookIds: [],
        windowStart: new Date(),
        windowEnd: new Date(),
        requestCount: 0,
      },
    });
    expect(await maybeEvolvePlaybook(on)).toBe("replay-pending");
    await prisma.aiReplayRun.update({ where: { id: run.id }, data: { status: "scored" } });
    expect(await maybeEvolvePlaybook(on)).toBe("not-due");
  });

  it("backs off for an hour after a due round that could not start", async () => {
    // Nothing was graded in 2000, so the round finds no holdout and ends without recording a run.
    const on = { ...env, AI_PLAYBOOK_EVOLUTION: true };
    const t0 = Date.UTC(2000, 0, 1, 12);
    expect(await maybeEvolvePlaybook(on, t0)).toBe("too-few-holdout-alerts");
    expect(await maybeEvolvePlaybook(on, t0 + 10 * 60_000)).toBe("not-due");
    expect(await maybeEvolvePlaybook(on, t0 + 59 * 60_000)).toBe("not-due");
    expect(await maybeEvolvePlaybook(on, t0 + 60 * 60_000)).toBe("too-few-holdout-alerts");
  });
});
