import {
  createLogger,
  prisma,
  pruneModelBackups,
  pruneTableBackups,
  saveModelBackup,
  saveTableBackup,
  uploadPendingBackups,
  uploadPendingTableBackups,
  weeklyBackupDue,
  weeklyTableBackupDue,
  type Env,
} from "@trenchscanner/core";
import { PartialJobFailure, type JobRunMeta } from "../scheduler.js";

const logger = createLogger("model-backup");
const DAY_MS = 86_400_000;

/**
 * Backups whose off-site copy has been refused for longer than a day (the bucket's token revoked or
 * expired, the bucket gone): one failed pass is retried the next hour and is no news, a day of them
 * means the only copy that survives losing the database is not being made. The window is the
 * uploads' own (30 days back).
 */
async function stuckOffsiteCopies(now: Date): Promise<{ models: number; tables: number }> {
  const where = {
    offsiteKey: null,
    offsiteError: { not: null },
    createdAt: { gte: new Date(now.getTime() - 30 * DAY_MS), lt: new Date(now.getTime() - DAY_MS) },
  };
  const [models, tables] = await Promise.all([
    prisma.modelBackup.count({ where }),
    prisma.dataBackup.count({ where }),
  ]);
  return { models, tables };
}

/**
 * The trainer's hourly backup pass (curation/modelBackup.ts): takes the weekly snapshot of every
 * running model once a week has passed since the last one (so a redeploy or a down day only
 * delays it, never skips it), copies any backup without an off-site copy to the bucket when
 * MODEL_BACKUP_S3_* is set, and prunes past MODEL_BACKUP_KEEP_WEEKS. The same pass takes the
 * weekly copy of the irreplaceable tables (backup/tableBackup.ts, DATA_BACKUP_KEEP kept, copied
 * to the same bucket); a failure there is logged and reported, and never stops the model half.
 *
 * Either failing - the table backup itself, or an off-site copy refused for over a day - ends the
 * pass as a PartialJobFailure: the heartbeat's lastError names it, so /health/worker and the admin
 * panel show it and pipeline-watch tells the admins, where before it sat in the nested meta that
 * nothing watched (full audit 2026-10-27, DB-8; 2026-10-17 P2-3).
 */
export async function runModelBackupJob(
  env: Env,
  now = new Date(),
  fetchImpl?: typeof fetch,
): Promise<JobRunMeta> {
  let created: string | null = null;
  if (await weeklyBackupDue(now)) {
    const backup = await saveModelBackup("weekly");
    if (backup) {
      created = backup.id;
      logger.info("weekly model backup taken", {
        id: backup.id,
        models: backup.modelCount,
        sizeBytes: backup.sizeBytes,
      });
    } else {
      logger.info("no active models to back up yet");
    }
  }
  const offsite = await uploadPendingBackups(env, { now, fetchImpl });
  if (offsite.failed > 0) logger.warn("off-site backup copy failed - retrying next pass", offsite);
  const pruned = await pruneModelBackups(env.MODEL_BACKUP_KEEP_WEEKS, now);

  const tables: Record<string, string | number | boolean | null> = {};
  try {
    if (await weeklyTableBackupDue(now)) {
      const backup = await saveTableBackup("weekly");
      tables.created = backup.id;
      logger.info("weekly table backup taken", {
        id: backup.id,
        rows: backup.rowCount,
        sizeBytes: backup.sizeBytes,
      });
    }
    const copies = await uploadPendingTableBackups(env, { now, fetchImpl });
    if (copies.failed > 0) logger.warn("off-site table backup copy failed - retrying next pass", copies);
    Object.assign(tables, { uploaded: copies.uploaded, uploadFailed: copies.failed });
    tables.pruned = await pruneTableBackups(env.DATA_BACKUP_KEEP);
  } catch (err) {
    logger.error("table backup failed", { error: String(err) });
    tables.error = String(err).slice(0, 300);
  }

  const stuck = offsite.configured ? await stuckOffsiteCopies(now) : { models: 0, tables: 0 };
  const meta: JobRunMeta = {
    created,
    offsiteConfigured: offsite.configured,
    uploaded: offsite.uploaded,
    uploadFailed: offsite.failed,
    pruned,
    // Admin > Backups reads the nested pass; /health/worker passes on only top-level numbers and
    // flags, so the failures are repeated there.
    tables,
    tableBackupFailed: typeof tables.error === "string",
    tablesUploadFailed: typeof tables.uploadFailed === "number" ? tables.uploadFailed : 0,
    offsiteStuckModels: stuck.models,
    offsiteStuckTables: stuck.tables,
  };
  const problems: string[] = [];
  if (typeof tables.error === "string") problems.push(`table backup failed: ${tables.error}`);
  if (stuck.models + stuck.tables > 0)
    problems.push(
      `off-site copy refused for over a day: ${stuck.models} model and ${stuck.tables} table backup(s)`,
    );
  if (problems.length > 0) throw new PartialJobFailure(`model-backup: ${problems.join("; ")}`, meta);
  return meta;
}
