import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  backupFileName,
  createLogger,
  decodeBackup,
  describeBackupSeats,
  encodeBackup,
  exportRunningModels,
  selectSeats,
  listModelBackups,
  loadBackupData,
  prisma,
  restoreModelBackup,
  saveModelBackup,
  storeBackupPayload,
  BACKUP_SUMMARY_SELECT,
  ModelBackupError,
  type Env,
} from "@trenchscanner/core";

const logger = createLogger("admin-backups");

/** A backup is a few MB at most today; generous room for a much bigger model field. */
const IMPORT_BODY_LIMIT = 64 * 1024 * 1024;

const createSchema = z.object({ note: z.string().trim().max(200).optional() });
const patchSchema = z.object({
  pinned: z.boolean().optional(),
  note: z.string().trim().max(200).nullable().optional(),
});
const restoreSchema = z.object({
  confirm: z.literal(true),
  seats: z.array(z.string().min(1).max(100)).max(50).optional(),
});
const seatsQuery = z.object({ seats: z.string().max(2000).optional() });

/** "?seats=a,b" -> ["a", "b"]; absent or empty -> []. */
function parseSeats(query: unknown): string[] {
  const parsed = seatsQuery.safeParse(query);
  if (!parsed.success || !parsed.data.seats) return [];
  return parsed.data.seats
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const fileName = (createdAt: Date, kind: string, id: string, seats: string[]) =>
  backupFileName({ createdAt, kind, id }).replace(
    /\.json\.gz$/,
    seats.length > 0 ? `-${seats.join("+").replace(/[^a-zA-Z0-9+_-]/g, "")}.json.gz` : ".json.gz",
  );

/**
 * The Admin tab's model backups (curation/modelBackup.ts): list, take one now, download, import a
 * downloaded file (the way back after losing the database), pin, and restore. Behind the same
 * admin wallet check as the rest of /admin.
 */
export async function registerAdminBackupRoutes(app: FastifyInstance, opts: { env: Env }) {
  // An imported file arrives as the raw download: gzip bytes, or the unzipped JSON as text.
  app.addContentTypeParser(
    ["application/gzip", "application/x-gzip", "application/octet-stream"],
    { parseAs: "buffer", bodyLimit: IMPORT_BODY_LIMIT },
    (_request, body, done) => done(null, body),
  );

  app.get("/model-backups", async () => {
    const [backups, heartbeat] = await Promise.all([
      listModelBackups(100),
      prisma.systemHeartbeat.findUnique({ where: { job: "model-backup" } }),
    ]);
    const meta = (heartbeat?.meta ?? null) as { offsiteConfigured?: boolean } | null;
    return {
      backups,
      keepWeeks: opts.env.MODEL_BACKUP_KEEP_WEEKS,
      // The trainer holds the bucket settings, so it is the one that knows - from its last pass.
      offsiteConfigured: typeof meta?.offsiteConfigured === "boolean" ? meta.offsiteConfigured : null,
      lastCheckAt: heartbeat?.lastRunAt ?? null,
      lastError: heartbeat?.lastError ?? null,
    };
  });

  app.post("/model-backups", async (request, reply) => {
    const parsed = createSchema.safeParse(request.body ?? {});
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    const backup = await saveModelBackup(
      "manual",
      parsed.data.note || `Taken by ${request.user!.walletAddress}`,
    );
    if (!backup) return reply.code(409).send({ error: "There are no trained models to back up yet." });
    logger.info("manual model backup taken", { id: backup.id, by: request.user!.walletAddress });
    return backup;
  });

  /** One backup and the seats it holds, for picking which models to export or restore. */
  app.get("/model-backups/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const loaded = await loadBackupData(id);
      if (!loaded) return reply.code(404).send({ error: "no such backup" });
      return { backup: loaded.row, seats: describeBackupSeats(decodeBackup(loaded.data)) };
    } catch (err) {
      if (err instanceof ModelBackupError) return reply.code(422).send({ error: err.message });
      throw err;
    }
  });

  /** The backup file, whole or (?seats=a,b) cut down to those models. */
  app.get("/model-backups/:id/download", async (request, reply) => {
    const { id } = request.params as { id: string };
    const seats = parseSeats(request.query);
    try {
      const loaded = await loadBackupData(id);
      if (!loaded) return reply.code(404).send({ error: "no such backup" });
      const data =
        seats.length > 0 ? encodeBackup(selectSeats(decodeBackup(loaded.data), seats)).data : loaded.data;
      return reply
        .header("content-type", "application/gzip")
        .header(
          "content-disposition",
          `attachment; filename="${fileName(loaded.row.createdAt, loaded.row.kind, loaded.row.id, seats)}"`,
        )
        .header("cache-control", "no-store")
        .send(data);
    } catch (err) {
      if (err instanceof ModelBackupError) return reply.code(422).send({ error: err.message });
      throw err;
    }
  });

  /** The seats running right now, as a backup would list them. */
  app.get("/models", async () => {
    const payload = await exportRunningModels();
    return { seats: payload ? describeBackupSeats(payload) : [] };
  });

  /** The models running right now as a backup file (?seats=a,b for some), without storing it. */
  app.get("/models/export", async (request, reply) => {
    const seats = parseSeats(request.query);
    try {
      const payload = await exportRunningModels(seats);
      if (!payload) return reply.code(409).send({ error: "There are no trained models to export yet." });
      return reply
        .header("content-type", "application/gzip")
        .header(
          "content-disposition",
          `attachment; filename="${fileName(new Date(payload.createdAt), "export", "running", seats)}"`,
        )
        .header("cache-control", "no-store")
        .send(encodeBackup(payload).data);
    } catch (err) {
      if (err instanceof ModelBackupError) return reply.code(422).send({ error: err.message });
      throw err;
    }
  });

  app.post("/model-backups/import", { bodyLimit: IMPORT_BODY_LIMIT }, async (request, reply) => {
    const body = request.body;
    const bytes = Buffer.isBuffer(body)
      ? body
      : typeof body === "object" && body !== null
        ? Buffer.from(JSON.stringify(body), "utf8")
        : null;
    if (!bytes || bytes.length === 0)
      return reply.code(400).send({ error: "send the backup file as the body" });
    try {
      const payload = decodeBackup(bytes);
      const stored = await storeBackupPayload(
        payload,
        "imported",
        `Imported from a ${payload.kind} backup of ${payload.createdAt.slice(0, 16).replace("T", " ")} UTC`,
      );
      logger.info("model backup imported", {
        id: stored.id,
        from: payload.createdAt,
        by: request.user!.walletAddress,
      });
      return stored;
    } catch (err) {
      if (err instanceof ModelBackupError) return reply.code(422).send({ error: err.message });
      throw err;
    }
  });

  app.patch("/model-backups/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = patchSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    const found = await prisma.modelBackup.findUnique({ where: { id }, select: { id: true } });
    if (!found) return reply.code(404).send({ error: "no such backup" });
    return prisma.modelBackup.update({
      where: { id },
      data: {
        ...(parsed.data.pinned !== undefined ? { pinned: parsed.data.pinned } : {}),
        ...(parsed.data.note !== undefined ? { note: parsed.data.note || null } : {}),
      },
      select: BACKUP_SUMMARY_SELECT,
    });
  });

  app.post("/model-backups/:id/restore", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = restoreSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'send {"confirm": true} to restore' });
    }
    try {
      const result = await restoreModelBackup(id, {
        actor: request.user!.walletAddress,
        seats: parsed.data.seats ?? [],
      });
      logger.warn("models restored from a backup", { ...result, by: request.user!.walletAddress });
      return result;
    } catch (err) {
      if (err instanceof ModelBackupError) {
        return reply.code(err.message === "no such backup" ? 404 : 422).send({ error: err.message });
      }
      throw err;
    }
  });
}
