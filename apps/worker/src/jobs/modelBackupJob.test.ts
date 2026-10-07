// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterEach, describe, expect, it } from "vitest";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  prisma,
  loadEnv,
  decodeBackup,
  describeBackupSeats,
  selectSeats,
  encodeBackup,
  loadBackupData,
  pruneModelBackups,
  restoreModelBackup,
  saveModelBackup,
  uploadPendingBackups,
  weeklyBackupDue,
  CURATOR_MODEL_KIND,
  STACKED_MODEL_KIND,
  ModelBackupError,
  sealBackupPayload,
  type ModelBackupPayload,
  type ContestantTrainingResult,
  type StackedCuratorParams,
  type TrainedCuratorParams,
} from "@trenchscanner/core";
import { applyContestResults } from "./curatorTrainingJob.js";
import { runModelBackupJob } from "./modelBackupJob.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

function learnerParams(bias: number): TrainedCuratorParams {
  return {
    kind: CURATOR_MODEL_KIND,
    featureNames: ["scoreTotal"],
    means: [50],
    stdevs: [10],
    weights: [2, 0],
    bias,
    threshold: 0.6,
  };
}

function stacked(): StackedCuratorParams {
  return {
    kind: STACKED_MODEL_KIND,
    members: [
      { contestant: "linear", modelId: "", quantiles: [0.5] },
      { contestant: "trees", modelId: "", quantiles: [0.5] },
    ],
    rules: { quantiles: [50], minScore: 55 },
    meta: { kind: CURATOR_MODEL_KIND, featureNames: [], means: [], stdevs: [], weights: [], bias: 0 },
    threshold: 0.5,
  };
}

function result(contestant: string, params: ContestantTrainingResult["params"]): ContestantTrainingResult {
  return {
    contestant,
    params,
    metrics: {
      folds: [],
      verdict: { promote: false, reason: "test" },
      targets: { winRate: 0.75, goalRate: 0.5, minSupport: 30 },
      precisionCalibration: { threshold: null, support: 0, winRatePct: null, goalRatePct: null },
      precisionCurve: [],
      heuristicPrecisionCurve: [],
      contestant,
    },
  };
}

const lane = (slot: string, name: string, generation: number, bornAt: Date) => ({
  slot,
  name,
  description: name,
  recipe: { learner: "logistic" as const },
  generation,
  parentName: null,
  bornAt,
});

async function seedGeneration(bias: number, laneName: string) {
  return applyContestResults(
    [
      result("consensus", stacked()),
      result("linear", learnerParams(bias)),
      result("trees", learnerParams(bias)),
    ],
    2_000,
    new Date(Date.now() - 86_400_000),
    {
      founding: [
        lane("linear", laneName, laneName === "Linear" ? 0 : 5, new Date(Date.now() - 3 * 86_400_000)),
      ],
    },
  );
}

describe.skipIf(!dbAvailable)("model backups", () => {
  afterEach(async () => {
    await prisma.modelBackup.deleteMany({});
    await prisma.curatorModel.deleteMany({});
    await prisma.curatorLane.deleteMany({});
  });

  it("backs up nothing before any model exists", async () => {
    expect(await saveModelBackup("manual")).toBeNull();
  });

  it("round-trips: a restore brings back the weights, cutoffs and recipe, with the consensus re-pointed", async () => {
    await seedGeneration(0.25, "Linear");
    const backup = (await saveModelBackup("weekly"))!;
    expect(backup.modelCount).toBe(3);
    const file = (await loadBackupData(backup.id))!;
    const payload = decodeBackup(file.data);
    expect(payload.lanes.map((l) => l.name)).toEqual(["Linear"]);
    expect(payload.models.map((m) => m.contestant).sort()).toEqual(["consensus", "linear", "trees"]);

    // A later generation, on a bred lane, replaces everything.
    await prisma.curatorLane.updateMany({ where: { retiredAt: null }, data: { retiredAt: new Date() } });
    await seedGeneration(-3, "Lean Linear #5");

    const restored = await restoreModelBackup(backup.id, { actor: "test" });
    expect(restored).toMatchObject({ models: 3, lanesRestored: 1 });
    expect(restored.safetyBackupId).not.toBeNull();

    const active = await prisma.curatorModel.findMany({ where: { status: "active" } });
    expect(active).toHaveLength(3);
    const linear = active.find((m) => m.contestant === "linear")!;
    expect((linear.params as unknown as { bias: number }).bias).toBe(0.25);
    const consensus = active.find((m) => m.contestant === "consensus")!;
    const members = (consensus.params as unknown as StackedCuratorParams).members;
    expect(members.map((m) => m.modelId).sort()).toEqual(
      active
        .filter((m) => m.contestant !== "consensus")
        .map((m) => m.id)
        .sort(),
    );
    const current = await prisma.curatorLane.findMany({ where: { slot: "linear", retiredAt: null } });
    expect(current.map((l) => l.name)).toEqual(["Linear"]);
    expect(current[0]!.bornAt.toISOString()).toBe(payload.lanes[0]!.bornAt);

    // The pre-restore backup holds what was running, so the restore can itself be undone.
    const safety = decodeBackup((await loadBackupData(restored.safetyBackupId!))!.data);
    expect(safety.lanes[0]!.name).toBe("Lean Linear #5");
    expect((await prisma.modelBackup.findUnique({ where: { id: backup.id } }))!.restoredAt).not.toBeNull();
  });

  it("restores a single model, leaving the other seats as they run", async () => {
    await seedGeneration(0.25, "Linear");
    const backup = (await saveModelBackup("manual"))!;
    const payload = decodeBackup((await loadBackupData(backup.id))!.data);
    const seats = describeBackupSeats(payload);
    expect(seats.find((s) => s.seat === "consensus")!.members).toEqual(["linear", "trees"]);
    expect(seats.find((s) => s.seat === "linear")).toMatchObject({ name: "Linear", threshold: 0.6 });

    // Picking the consensus brings its members; picking a learner brings only itself.
    expect(
      selectSeats(payload, ["consensus"])
        .models.map((m) => m.contestant)
        .sort(),
    ).toEqual(["consensus", "linear", "trees"]);
    const justLinear = selectSeats(payload, ["linear"]);
    expect(justLinear.models.map((m) => m.contestant)).toEqual(["linear"]);
    expect(decodeBackup(encodeBackup(justLinear).data).models).toHaveLength(1);
    expect(() => selectSeats(payload, ["nope"])).toThrow(ModelBackupError);

    await seedGeneration(-3, "Linear");
    const trees = await prisma.curatorModel.findFirstOrThrow({
      where: { status: "active", contestant: "trees" },
    });
    const restored = await restoreModelBackup(backup.id, { seats: ["linear"] });
    expect(restored.seats).toEqual(["linear"]);
    const active = await prisma.curatorModel.findMany({ where: { status: "active" } });
    const bias = (c: string) =>
      (active.find((m) => m.contestant === c)!.params as unknown as { bias: number }).bias;
    expect(bias("linear")).toBe(0.25);
    expect(bias("trees")).toBe(-3);
    expect(active.find((m) => m.contestant === "trees")!.id).toBe(trees.id);
  });

  it("a training run that started before a restore does not overwrite it", async () => {
    await seedGeneration(0.25, "Linear");
    const backup = (await saveModelBackup("manual"))!;
    const runStarted = new Date();
    await new Promise((r) => setTimeout(r, 5));
    await restoreModelBackup(backup.id);
    const stored = await applyContestResults(
      [result("linear", learnerParams(9))],
      2_000,
      new Date(),
      {},
      {
        startedAt: runStarted,
      },
    );
    expect(stored).toBeNull();
    const linear = await prisma.curatorModel.findFirstOrThrow({
      where: { status: "active", contestant: "linear" },
    });
    expect((linear.params as unknown as { bias: number }).bias).toBe(0.25);
  });

  it("refuses a tampered or truncated file", async () => {
    await seedGeneration(0.25, "Linear");
    const backup = (await saveModelBackup("manual"))!;
    const { data } = (await loadBackupData(backup.id))!;
    const json = JSON.parse(gunzipSync(data).toString("utf8"));
    json.models[0].params.threshold = 0.01;
    expect(() => decodeBackup(Buffer.from(JSON.stringify(json)))).toThrow(ModelBackupError);
    expect(() => decodeBackup(data.subarray(0, data.length - 20))).toThrow(ModelBackupError);
    // Plain JSON of an untouched payload is fine (an unzipped download).
    expect(decodeBackup(gunzipSync(data)).models).toHaveLength(3);
    expect(encodeBackup(decodeBackup(data)).data.length).toBeGreaterThan(0);
  });

  it("refuses a sealed file whose fields the restore could not write", async () => {
    await seedGeneration(0.25, "Linear");
    const backup = (await saveModelBackup("manual"))!;
    const { data } = (await loadBackupData(backup.id))!;
    const good = JSON.parse(gunzipSync(data).toString("utf8")) as ModelBackupPayload;
    const { integrity: _i, ...body } = good;
    const reseal = (change: (p: typeof body) => void) => {
      const copy = JSON.parse(JSON.stringify(body)) as typeof body;
      change(copy);
      return Buffer.from(JSON.stringify(sealBackupPayload(copy)));
    };
    // Each of these passed the integrity check and failed later, as a 500 or inside the restore.
    expect(() => decodeBackup(reseal((p) => ((p as { createdAt: unknown }).createdAt = 5)))).toThrow(
      /createdAt/,
    );
    expect(() => decodeBackup(reseal((p) => ((p as { liveRecords: unknown }).liveRecords = null)))).toThrow(
      ModelBackupError,
    );
    expect(() => decodeBackup(reseal((p) => (p.lanes[0]!.bornAt = "yesterday")))).toThrow(/bornAt/);
    expect(() => decodeBackup(reseal((p) => (p.models[0]!.trainingTo = undefined as never)))).toThrow(
      /trainingTo/,
    );
    expect(() =>
      decodeBackup(reseal((p) => ((p.models[0]!.params as unknown as { x: unknown }).x = "no"))),
    ).not.toThrow();
    // Untouched, it still reads.
    expect(decodeBackup(reseal(() => undefined)).models).toHaveLength(3);
  });

  it("refuses a file that unzips to more than a backup could be", () => {
    // 64MB of zeros gzips to ~64KB; a 512MB cap is what stops a bomb, so this is a cap of our own.
    const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(200_000);
    expect(() => decodeBackup(bomb)).toThrow(ModelBackupError);
  });

  it("the hourly pass takes a weekly backup once a week and keeps the newest N", async () => {
    await seedGeneration(0.25, "Linear");
    const env = loadEnv();
    expect(await weeklyBackupDue()).toBe(true);
    const first = await runModelBackupJob(env);
    expect(first.created).not.toBeNull();
    expect((await runModelBackupJob(env)).created).toBeNull();

    // Twelve more weeks of history, one of them pinned.
    for (let i = 1; i <= 12; i++) {
      const b = (await saveModelBackup("weekly"))!;
      await prisma.modelBackup.update({
        where: { id: b.id },
        data: { createdAt: new Date(Date.now() - i * 7 * 86_400_000), pinned: i === 12 },
      });
    }
    const pruned = await pruneModelBackups(8);
    expect(pruned).toBe(4);
    expect(await prisma.modelBackup.count({ where: { kind: "weekly" } })).toBe(9);
    expect(await prisma.modelBackup.count({ where: { pinned: true } })).toBe(1);
  });

  it("caps manual, pre-restore and imported backups by count as well as by age", async () => {
    // A restore writes a pre-restore row every time and "back up now" is one click, so without
    // a cap a busy admin's week would hold the full payload dozens of times over inside the 90
    // days. Each kind has its own cap, and pinned rows and weekly rows are outside it.
    await seedGeneration(0.25, "Linear");
    const seed = async (
      kind: "manual" | "pre-restore" | "imported" | "weekly",
      daysAgo: number,
      pinned = false,
    ) => {
      const b = (await saveModelBackup(kind))!;
      await prisma.modelBackup.update({
        where: { id: b.id },
        data: { createdAt: new Date(Date.now() - daysAgo * 86_400_000), pinned },
      });
      return b.id;
    };
    // 23 manual backups, newest first, the oldest of them pinned; two pre-restore rows, one past
    // the age horizon; a couple of weekly rows well inside their count.
    const manual: string[] = [];
    for (let i = 0; i < 23; i++) manual.push(await seed("manual", i, i === 22));
    const preRestoreRecent = await seed("pre-restore", 1);
    const preRestoreAncient = await seed("pre-restore", 91);
    await seed("weekly", 0);
    await seed("weekly", 7);

    // Two unpinned manual rows past the newest 20, plus the pre-restore row past 90 days.
    expect(await pruneModelBackups(12)).toBe(3);
    const left = new Set((await prisma.modelBackup.findMany({ select: { id: true } })).map((r) => r.id));
    for (const id of manual.slice(0, 20)) expect(left.has(id)).toBe(true);
    expect(left.has(manual[20]!)).toBe(false);
    expect(left.has(manual[21]!)).toBe(false);
    // The pinned one is the oldest, and stays.
    expect(left.has(manual[22]!)).toBe(true);
    expect(left.has(preRestoreRecent)).toBe(true);
    expect(left.has(preRestoreAncient)).toBe(false);
    expect(await prisma.modelBackup.count({ where: { kind: "weekly" } })).toBe(2);
    // Running it again finds nothing more to do.
    expect(await pruneModelBackups(12)).toBe(0);
  });

  it("copies new backups off-site when a bucket is configured, and records a failure for retry", async () => {
    await seedGeneration(0.25, "Linear");
    const backup = (await saveModelBackup("manual"))!;
    const env = {
      ...loadEnv(),
      MODEL_BACKUP_S3_ENDPOINT: "https://example.r2.cloudflarestorage.com",
      MODEL_BACKUP_S3_BUCKET: "models",
      MODEL_BACKUP_S3_ACCESS_KEY_ID: "id",
      MODEL_BACKUP_S3_SECRET_ACCESS_KEY: "secret",
    };
    const failing = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    expect(await uploadPendingBackups(env, { fetchImpl: failing })).toMatchObject({ uploaded: 0, failed: 1 });
    expect((await prisma.modelBackup.findUnique({ where: { id: backup.id } }))!.offsiteError).toContain(
      "500",
    );

    const puts: string[] = [];
    const ok = (async (url: URL) => {
      puts.push(url.toString());
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    expect(await uploadPendingBackups(env, { fetchImpl: ok })).toMatchObject({ uploaded: 1, failed: 0 });
    const row = (await prisma.modelBackup.findUnique({ where: { id: backup.id } }))!;
    expect(row.offsiteKey).toMatch(
      /^trenchscanner\/model-backups\/trenchscanner-models-.*-manual-.*\.json\.gz$/,
    );
    expect(row.offsiteError).toBeNull();
    expect(puts[0]).toContain("/models/trenchscanner/model-backups/");
    expect(await uploadPendingBackups(loadEnv())).toMatchObject({ configured: false });
  });
});
