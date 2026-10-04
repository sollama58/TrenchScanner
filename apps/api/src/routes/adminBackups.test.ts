// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CURATOR_MODEL_KIND,
  MODEL_BACKUP_FORMAT,
  MODEL_BACKUP_VERSION,
  encodeBackup,
  loadEnv,
  prisma,
  sealBackupPayload,
  type Env,
} from "@trenchscanner/core";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";

const ADMIN_WALLET = "AdminBackups1111111111111111111111111111111";
const OTHER_WALLET = "NotAdminBackups111111111111111111111111111";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
/** A seat no other test file uses: the API's test files share one database and run in parallel. */
const SEAT = "backup-test-seat";
const userIds: Record<"admin" | "other", string> = { admin: "", other: "" };

async function call(
  as: "admin" | "other",
  req: { method: "GET" | "POST" | "PATCH"; url: string; payload?: unknown; headers?: Record<string, string> },
) {
  const env: Env = { ...loadEnv(), ADMIN_WALLET_ADDRESSES: ADMIN_WALLET };
  const app = await buildServer(env);
  try {
    const cookie = await createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS).sign({
      userId: userIds[as],
      walletAddress: as === "admin" ? ADMIN_WALLET : OTHER_WALLET,
    });
    return await app.inject({
      ...req,
      payload: req.payload as string | Buffer | object | undefined,
      cookies: { [SESSION_COOKIE_NAME]: cookie },
    });
  } finally {
    await app.close();
  }
}

describe.skipIf(!dbAvailable)("admin model backups", () => {
  beforeAll(async () => {
    await prisma.modelBackup.deleteMany({});
    await prisma.curatorModel.deleteMany({ where: { contestant: SEAT } });
    await prisma.user.deleteMany({ where: { walletAddress: { in: [ADMIN_WALLET, OTHER_WALLET] } } });
    userIds.admin = (await prisma.user.create({ data: { walletAddress: ADMIN_WALLET } })).id;
    userIds.other = (await prisma.user.create({ data: { walletAddress: OTHER_WALLET } })).id;
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.modelBackup.deleteMany({});
    await prisma.curatorModel.deleteMany({ where: { contestant: SEAT } });
    await prisma.user.deleteMany({ where: { walletAddress: { in: [ADMIN_WALLET, OTHER_WALLET] } } });
  });

  it("refuses a non-admin, before reading an import body", async () => {
    expect((await call("other", { method: "GET", url: "/admin/model-backups" })).statusCode).toBe(403);
    const res = await call("other", {
      method: "POST",
      url: "/admin/model-backups/import",
      payload: Buffer.from([1, 2, 3]),
      headers: { "content-type": "application/gzip" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("takes, downloads, imports, pins and restores a backup", async () => {
    await prisma.curatorModel.create({
      data: {
        contestant: SEAT,
        kind: CURATOR_MODEL_KIND,
        params: {
          kind: CURATOR_MODEL_KIND,
          featureNames: [],
          means: [],
          stdevs: [],
          weights: [],
          bias: 0.5,
          threshold: 0.7,
        },
        trainingRows: 1000,
        trainingFrom: new Date(Date.now() - 86_400_000),
        trainingTo: new Date(),
        evalMetrics: {},
        status: "active",
        activatedAt: new Date(),
      },
    });
    const taken = await call("admin", {
      method: "POST",
      url: "/admin/model-backups",
      payload: { note: "good week" },
    });
    expect(taken.statusCode, taken.body).toBe(200);
    const backup = taken.json() as { id: string; note: string; modelCount: number };
    expect(backup.note).toBe("good week");
    expect(backup.modelCount).toBeGreaterThanOrEqual(1);

    const list = await call("admin", { method: "GET", url: "/admin/model-backups" });
    expect(list.json().backups.map((b: { id: string }) => b.id)).toContain(backup.id);

    const download = await call("admin", {
      method: "GET",
      url: `/admin/model-backups/${backup.id}/download`,
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-disposition"]).toMatch(
      /attachment; filename="trenchscanner-models-.*\.json\.gz"/,
    );
    const file = download.rawPayload;

    const imported = await call("admin", {
      method: "POST",
      url: "/admin/model-backups/import",
      payload: file,
      headers: { "content-type": "application/gzip" },
    });
    expect(imported.statusCode, imported.body).toBe(200);
    expect(imported.json()).toMatchObject({ kind: "imported", modelCount: backup.modelCount });

    const garbage = await call("admin", {
      method: "POST",
      url: "/admin/model-backups/import",
      payload: file.subarray(0, 40),
      headers: { "content-type": "application/gzip" },
    });
    expect(garbage.statusCode).toBe(422);

    const pinned = await call("admin", {
      method: "PATCH",
      url: `/admin/model-backups/${backup.id}`,
      payload: { pinned: true },
    });
    expect(pinned.json()).toMatchObject({ pinned: true });

    expect(
      (await call("admin", { method: "POST", url: `/admin/model-backups/${backup.id}/restore`, payload: {} }))
        .statusCode,
    ).toBe(400);
    // Restore a hand-made backup of this test's seat alone, so no other file's models change hands.
    const own = encodeBackup(
      sealBackupPayload({
        format: MODEL_BACKUP_FORMAT,
        version: MODEL_BACKUP_VERSION,
        createdAt: new Date().toISOString(),
        kind: "manual",
        note: null,
        models: [
          {
            id: "old-id",
            contestant: SEAT,
            kind: CURATOR_MODEL_KIND,
            params: {
              kind: CURATOR_MODEL_KIND,
              featureNames: [],
              means: [],
              stdevs: [],
              weights: [],
              bias: 2,
              threshold: 0.4,
            },
            trainingRows: 900,
            trainingFrom: new Date(Date.now() - 86_400_000).toISOString(),
            trainingTo: new Date().toISOString(),
            evalMetrics: {},
            activatedAt: null,
            createdAt: new Date().toISOString(),
          },
        ],
        lanes: [],
        liveRecords: {},
        champion: null,
        aiPlaybook: null,
        aiBlend: null,
      }),
    ).data;
    const ownImport = await call("admin", {
      method: "POST",
      url: "/admin/model-backups/import",
      payload: own,
      headers: { "content-type": "application/gzip" },
    });
    expect(ownImport.statusCode, ownImport.body).toBe(200);
    const restored = await call("admin", {
      method: "POST",
      url: `/admin/model-backups/${ownImport.json().id}/restore`,
      payload: { confirm: true },
    });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json()).toMatchObject({ models: 1 });
    const active = await prisma.curatorModel.findMany({ where: { status: "active", contestant: SEAT } });
    expect(active.map((m) => (m.params as { bias: number }).bias)).toEqual([2]);
  });
});
