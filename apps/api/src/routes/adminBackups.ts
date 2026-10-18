import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  backupFileName,
  createLogger,
  dbDumpConfig,
  dbDumpDownload,
  DbDumpError,
  decodeBackup,
  describeBackupSeats,
  encodeBackup,
  exportRunningModels,
  selectSeats,
  listDbDumps,
  listModelBackups,
  listTableBackups,
  loadBackupData,
  loadTableBackupData,
  tableBackupFileName,
  TableBackupError,
  prisma,
  restoreModelBackup,
  saveModelBackup,
  storeBackupPayload,
  BACKUP_SUMMARY_SELECT,
  ModelBackupError,
  type Env,
  walletTag,
} from "@trenchscanner/core";
import { requireAdminConfirmation } from "../tradeConfirm.js";

const logger = createLogger("admin-backups");

/** A backup is a few MB at most today; generous room for a much bigger model field. */
const IMPORT_BODY_LIMIT = 64 * 1024 * 1024;

/**
 * Backups live in the same small Postgres, and pinned ones are never pruned: a cap on pins, and
 * an hourly cap on taking and importing, keep a stuck button or a stolen session from filling it.
 */
const MAX_PINNED_BACKUPS = 10;
const BACKUP_WRITE_LIMIT = { rateLimit: { max: 10, timeWindow: "1 hour" } };

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

  app.post("/model-backups", { config: BACKUP_WRITE_LIMIT }, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body ?? {});
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    const backup = await saveModelBackup(
      "manual",
      parsed.data.note || `Taken by ${request.user!.walletAddress}`,
    );
    if (!backup) return reply.code(409).send({ error: "There are no trained models to back up yet." });
    logger.info("manual model backup taken", { id: backup.id, by: walletTag(request.user!.walletAddress) });
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

  /**
   * The weekly copies of the irreplaceable tables (backup/tableBackup.ts): list and download.
   * There is no restore route on purpose: a restore is a shell step against a database someone
   * has looked at first (README, "Restore").
   */
  app.get("/table-backups", async () => {
    const [backups, heartbeat] = await Promise.all([
      listTableBackups(100),
      prisma.systemHeartbeat.findUnique({ where: { job: "model-backup" } }),
    ]);
    const meta = (heartbeat?.meta ?? null) as { offsiteConfigured?: boolean; tables?: unknown } | null;
    return {
      backups,
      keep: opts.env.DATA_BACKUP_KEEP,
      offsiteConfigured: typeof meta?.offsiteConfigured === "boolean" ? meta.offsiteConfigured : null,
      lastCheckAt: heartbeat?.lastRunAt ?? null,
      lastPass: meta?.tables ?? null,
    };
  });

  // Every user's wallet, Telegram chats and trading rows: a wallet signature, in the query.
  app.get("/table-backups/:id/download", async (request, reply) => {
    if (!(await requireAdminConfirmation(request, reply))) return;
    const { id } = request.params as { id: string };
    try {
      const loaded = await loadTableBackupData(id);
      if (!loaded) return reply.code(404).send({ error: "no such backup" });
      return reply
        .header("content-type", "application/gzip")
        .header("content-disposition", `attachment; filename="${tableBackupFileName(loaded.row)}"`)
        .header("cache-control", "no-store")
        .send(loaded.data);
    } catch (err) {
      if (err instanceof TableBackupError) return reply.code(422).send({ error: err.message });
      throw err;
    }
  });

  /**
   * The full database dumps (backup/dbDumps.ts): the nightly pg_dumps the trenchscanner-db-backup
   * cron writes to the dumps bucket, and any "Dump now" waiting for it. Taking one is Admin >
   * Worker's run-now of the db-dump job (POST /admin/jobs/db-dump/run-now), which this panel calls.
   */
  app.get("/db-dumps", async (_request, reply) => {
    const cfg = dbDumpConfig(opts.env);
    const [heartbeat, pending, lastRequest] = await Promise.all([
      prisma.systemHeartbeat.findUnique({ where: { job: "db-dump" } }),
      prisma.jobRunRequest.findFirst({
        where: { job: "db-dump", startedAt: null },
        orderBy: { requestedAt: "asc" },
      }),
      prisma.jobRunRequest.findFirst({ where: { job: "db-dump" }, orderBy: { requestedAt: "desc" } }),
    ]);
    const meta = (heartbeat?.meta ?? null) as { runningSince?: unknown; sizeBytes?: unknown } | null;
    const state = {
      lastRunAt: heartbeat?.lastRunAt ?? null,
      lastSuccessAt: heartbeat?.lastSuccessAt ?? null,
      lastError: heartbeat?.lastError ?? null,
      runningSince: typeof meta?.runningSince === "string" ? meta.runningSince : null,
      pending: pending ? { requestedAt: pending.requestedAt } : null,
      lastRequest: lastRequest
        ? { requestedAt: lastRequest.requestedAt, startedAt: lastRequest.startedAt }
        : null,
    };
    if (!cfg) return { configured: false, dumps: [], ...state };
    try {
      return { configured: true, dumps: await listDbDumps(cfg), ...state };
    } catch (err) {
      logger.warn("could not list the database dumps", { error: (err as Error).message });
      return reply.code(502).send({ error: `Could not read the dumps bucket: ${(err as Error).message}` });
    }
  });

  // The whole database, every user's data included: a wallet signature, in the query. The answer
  // is a short-lived link to the bucket, so the file never passes through the API.
  app.get("/db-dumps/:name/download", async (request, reply) => {
    if (!(await requireAdminConfirmation(request, reply))) return;
    const cfg = dbDumpConfig(opts.env);
    if (!cfg) return reply.code(409).send({ error: "The dumps bucket isn't set on the API (DB_DUMP_S3_*)." });
    const { name } = request.params as { name: string };
    try {
      const link = await dbDumpDownload(cfg, name);
      if (!link) return reply.code(404).send({ error: "no such dump" });
      return reply.header("cache-control", "no-store").send(link);
    } catch (err) {
      if (err instanceof DbDumpError) return reply.code(422).send({ error: err.message });
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

  app.post(
    "/model-backups/import",
    { bodyLimit: IMPORT_BODY_LIMIT, config: BACKUP_WRITE_LIMIT },
    async (request, reply) => {
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
          by: walletTag(request.user!.walletAddress),
        });
        return stored;
      } catch (err) {
        if (err instanceof ModelBackupError) return reply.code(422).send({ error: err.message });
        throw err;
      }
    },
  );

  app.patch("/model-backups/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = patchSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    const found = await prisma.modelBackup.findUnique({ where: { id }, select: { id: true, pinned: true } });
    if (!found) return reply.code(404).send({ error: "no such backup" });
    if (parsed.data.pinned && !found.pinned) {
      const pinned = await prisma.modelBackup.count({ where: { pinned: true } });
      if (pinned >= MAX_PINNED_BACKUPS) {
        return reply.code(409).send({
          error: `${pinned} backups are pinned already: unpin one first (at most ${MAX_PINNED_BACKUPS}).`,
        });
      }
    }
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
    // A restore puts the backup's models and AI playbook in charge, and an imported file's hash
    // is its own: so it takes the wallet's signature over this exact request.
    if (!(await requireAdminConfirmation(request, reply))) return;
    try {
      const result = await restoreModelBackup(id, {
        actor: request.user!.walletAddress,
        seats: parsed.data.seats ?? [],
      });
      logger.warn("models restored from a backup", { ...result, by: walletTag(request.user!.walletAddress) });
      return result;
    } catch (err) {
      if (err instanceof ModelBackupError) {
        return reply.code(err.message === "no such backup" ? 404 : 422).send({ error: err.message });
      }
      throw err;
    }
  });
}
