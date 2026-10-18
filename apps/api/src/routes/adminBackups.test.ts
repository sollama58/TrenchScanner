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
import bs58 from "bs58";
import nacl from "tweetnacl";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";

/** A real keypair: a restore and a table download take the admin wallet's signature. */
const adminKeys = nacl.sign.keyPair();
const ADMIN_WALLET = bs58.encode(adminKeys.publicKey);
const OTHER_WALLET = "NotAdminBackups111111111111111111111111111";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
/** A seat no other test file uses: the API's test files share one database and run in parallel. */
const SEAT = "backup-test-seat";
const userIds: Record<"admin" | "other", string> = { admin: "", other: "" };

/**
 * One request as `as`. A restore is signed by the admin wallet as the dashboard does (asks
 * /admin/confirm for the text and sends the signature), unless `unsigned`; `deviceId` makes it a
 * paired phone's session.
 */
async function call(
  as: "admin" | "other",
  req: { method: "GET" | "POST" | "PATCH"; url: string; payload?: unknown; headers?: Record<string, string> },
  opts: { unsigned?: boolean; deviceId?: string } = {},
) {
  const env: Env = { ...loadEnv(), ADMIN_WALLET_ADDRESSES: ADMIN_WALLET };
  const app = await buildServer(env);
  try {
    const cookie = await createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS).sign({
      userId: userIds[as],
      walletAddress: as === "admin" ? ADMIN_WALLET : OTHER_WALLET,
      ...(opts.deviceId ? { deviceId: opts.deviceId } : {}),
    });
    const cookies = { [SESSION_COOKIE_NAME]: cookie };
    let payload = req.payload as string | Buffer | object | undefined;
    if (as === "admin" && !opts.unsigned && !opts.deviceId && /\/restore$/.test(req.url)) {
      const body = (payload ?? {}) as Record<string, unknown>;
      const confirmation = await signed(app, cookies, req.method, req.url, body);
      if (confirmation) payload = { ...body, confirmation };
    }
    return await app.inject({ ...req, payload, cookies });
  } finally {
    await app.close();
  }
}

async function signed(
  app: Awaited<ReturnType<typeof buildServer>>,
  cookies: Record<string, string>,
  method: string,
  path: string,
  body: Record<string, unknown>,
) {
  const challenge = await app.inject({
    method: "POST",
    url: "/admin/confirm",
    cookies,
    payload: { method, path, body },
  });
  if (challenge.statusCode !== 200) return null;
  const { nonce, message } = challenge.json<{ nonce: string; message: string }>();
  return {
    nonce,
    signature: bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), adminKeys.secretKey)),
  };
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
    await prisma.adminAction.deleteMany({ where: { wallet: { in: [ADMIN_WALLET, OTHER_WALLET] } } });
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

    // Per-model: list what's running, export one seat, and list/download one seat of a backup.
    const running = await call("admin", { method: "GET", url: "/admin/models" });
    expect(running.json().seats.map((x: { seat: string }) => x.seat)).toContain(SEAT);
    const exported = await call("admin", { method: "GET", url: `/admin/models/export?seats=${SEAT}` });
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.headers["content-disposition"]).toContain(`-${SEAT}.json.gz`);
    const detail = await call("admin", { method: "GET", url: `/admin/model-backups/${ownImport.json().id}` });
    expect(detail.json().seats).toEqual([expect.objectContaining({ seat: SEAT, threshold: 0.4 })]);
    const one = await call("admin", {
      method: "GET",
      url: `/admin/model-backups/${backup.id}/download?seats=${SEAT}`,
    });
    expect(one.statusCode, one.body).toBe(200);
    const reimported = await call("admin", {
      method: "POST",
      url: "/admin/model-backups/import",
      payload: one.rawPayload,
      headers: { "content-type": "application/gzip" },
    });
    expect(reimported.json()).toMatchObject({ modelCount: 1 });
    const missing = await call("admin", { method: "GET", url: `/admin/models/export?seats=no-such-seat` });
    expect(missing.statusCode).toBe(422);
    const partial = await call("admin", {
      method: "POST",
      url: `/admin/model-backups/${reimported.json().id}/restore`,
      payload: { confirm: true, seats: [SEAT] },
    });
    expect(partial.json()).toMatchObject({ seats: [SEAT] });
  });
  it("asks a browser session for the wallet's signature to restore or download table data, not a paired phone", async () => {
    const restore = {
      method: "POST" as const,
      url: "/admin/model-backups/no-such-backup/restore",
      payload: { confirm: true },
    };
    const unsigned = await call("admin", restore, { unsigned: true });
    expect(unsigned.statusCode).toBe(428);
    expect(unsigned.json().code).toBe("confirmation_required");
    // Signed, it gets as far as the lookup.
    expect((await call("admin", restore)).statusCode).toBe(404);
    // A signature for another request is worthless for this one.
    const env: Env = { ...loadEnv(), ADMIN_WALLET_ADDRESSES: ADMIN_WALLET };
    const app = await buildServer(env);
    try {
      const cookies = {
        [SESSION_COOKIE_NAME]: await createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS).sign({
          userId: userIds.admin,
          walletAddress: ADMIN_WALLET,
        }),
      };
      const other = await signed(app, cookies, "POST", "/admin/model-backups/another/restore", {
        confirm: true,
      });
      const misused = await app.inject({
        ...restore,
        cookies,
        payload: { confirm: true, confirmation: other },
      });
      expect(misused.statusCode).toBe(403);
      // The table download signs an empty body, its confirmation in the query.
      const url = "/admin/table-backups/no-such-backup/download";
      expect((await app.inject({ method: "GET", url, cookies })).statusCode).toBe(428);
      const c = await signed(app, cookies, "GET", url, {});
      const ok = await app.inject({
        method: "GET",
        url: `${url}?nonce=${encodeURIComponent(c!.nonce)}&signature=${encodeURIComponent(c!.signature)}`,
        cookies,
      });
      expect(ok.statusCode).toBe(404);
    } finally {
      await app.close();
    }

    // A paired phone may do everything without signing (user decision, 2026-10-18).
    const device = await prisma.linkedDevice.create({ data: { userId: userIds.admin } });
    expect((await call("admin", restore, { deviceId: device.id })).statusCode).toBe(404);
    expect(
      (
        await call(
          "admin",
          { method: "GET", url: "/admin/table-backups/no-such-backup/download" },
          { deviceId: device.id },
        )
      ).statusCode,
    ).toBe(404);

    // Each admin write lands in the action log, refused ones too, with the phone marked; a
    // non-admin's never does.
    await call("other", restore);
    const log = (
      await prisma.adminAction.findMany({
        where: { route: "/admin/model-backups/:id/restore", wallet: { in: [ADMIN_WALLET, OTHER_WALLET] } },
        orderBy: { at: "asc" },
      })
    ).filter((r) => (r.detail as { params?: { id?: string } } | null)?.params?.id === "no-such-backup");
    expect(log.map((r) => [r.statusCode, r.deviceId !== null])).toEqual([
      [428, false],
      [404, false],
      [403, false],
      [404, true],
    ]);
    expect(log[0]!.detail).toMatchObject({ params: { id: "no-such-backup" }, body: { confirm: true } });
    expect(JSON.stringify(log.map((r) => r.detail))).not.toContain("signature");
  });

  it("caps pinned backups", async () => {
    const ids = await Promise.all(
      Array.from(
        { length: 11 },
        async (_, i) =>
          (
            await prisma.modelBackup.create({
              data: {
                kind: "manual",
                note: `pin cap ${i}`,
                data: Buffer.from("x"),
                sha256: "x",
                sizeBytes: 1,
                modelCount: 0,
              },
              select: { id: true },
            })
          ).id,
      ),
    );
    for (const id of ids.slice(0, 10)) {
      await prisma.modelBackup.update({ where: { id }, data: { pinned: true } });
    }
    const refused = await call("admin", {
      method: "PATCH",
      url: `/admin/model-backups/${ids[10]}`,
      payload: { pinned: true },
    });
    expect(refused.statusCode).toBe(409);
  });
});
