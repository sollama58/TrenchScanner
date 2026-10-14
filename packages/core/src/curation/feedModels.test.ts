import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../db.js";
import type { ContestantSpec } from "./contestants.js";
import { sittingOutCombiners } from "./feedModels.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `feedmodels-test-${Date.now()}`;

/**
 * A combiner sits out while a member's active model isn't the one it was trained beside (the
 * worker's `usable` filter); the API and the dispatcher read the same answer from here.
 */
describe.skipIf(!dbAvailable)("sittingOutCombiners", () => {
  afterAll(async () => {
    await prisma.curatorModel.deleteMany({ where: { contestant: { startsWith: TAG } } });
  });

  it("names the combiners whose members' active models moved on, and no one else", async () => {
    const id = (k: string) => `${TAG}-${k}`;
    const spec = (k: string, role: string) => ({ id: id(k), name: k, role }) as unknown as ContestantSpec;
    const model = (k: string, status: string, params: object, minutesAgo = 0) => ({
      id: `${id(k)}-${status}-${minutesAgo}`,
      contestant: id(k),
      kind: "test",
      params,
      trainingRows: 1,
      trainingFrom: new Date(),
      trainingTo: new Date(),
      evalMetrics: {},
      status,
      createdAt: new Date(Date.now() - minutesAgo * 60_000),
    });
    const a = model("a", "active", { threshold: 0.5 });
    const b = model("b", "active", { threshold: 0.5 });
    const members = (...ms: (typeof a)[]) => ({
      members: ms.map((m) => ({ contestant: m.contestant, modelId: m.id })),
    });
    const oldB = model("b", "retired", { threshold: 0.5 }, 60);
    await prisma.curatorModel.createMany({
      data: [
        a,
        b,
        oldB,
        // Trained beside today's a and b: calls.
        model("fresh", "active", { threshold: 0.5, ...members(a, b) }),
        // Trained beside b's previous model: sits out.
        model("stale", "active", { threshold: 0.5, ...members(a, oldB) }),
        // Its newest active row is fresh; an older active row that was stale doesn't count.
        model("renewed", "active", { threshold: 0.5, ...members(a, b) }),
        model("renewed", "active", { threshold: 0.5, ...members(oldB) }, 30),
        // A learner with a `members` key is not a combiner: never read.
        model("learner", "active", { threshold: 0.5, ...members(oldB) }),
      ],
    });
    const roster = [
      spec("a", "learner"),
      spec("b", "learner"),
      spec("fresh", "stacked"),
      spec("stale", "agreement"),
      spec("renewed", "blend"),
      spec("learner", "learner"),
    ];
    expect([...(await sittingOutCombiners(roster))]).toEqual([id("stale")]);
    expect(await sittingOutCombiners(roster.filter((c) => c.role === "learner"))).toEqual(new Set());
  });
});
