import {
  createLogger,
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
import type { JobRunMeta } from "../scheduler.js";

const logger = createLogger("model-backup");

/**
 * The trainer's hourly backup pass (curation/modelBackup.ts): takes the weekly snapshot of every
 * running model once a week has passed since the last one (so a redeploy or a down day only
 * delays it, never skips it), copies any backup without an off-site copy to the bucket when
 * MODEL_BACKUP_S3_* is set, and prunes past MODEL_BACKUP_KEEP_WEEKS. The same pass takes the
 * weekly copy of the irreplaceable tables (backup/tableBackup.ts, DATA_BACKUP_KEEP kept, copied
 * to the same bucket); a failure there is logged and reported, and never stops the model half.
 */
export async function runModelBackupJob(env: Env, now = new Date()): Promise<JobRunMeta> {
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
  const offsite = await uploadPendingBackups(env, { now });
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
    const copies = await uploadPendingTableBackups(env, { now });
    if (copies.failed > 0) logger.warn("off-site table backup copy failed - retrying next pass", copies);
    Object.assign(tables, { uploaded: copies.uploaded, uploadFailed: copies.failed });
    tables.pruned = await pruneTableBackups(env.DATA_BACKUP_KEEP);
  } catch (err) {
    logger.error("table backup failed", { error: String(err) });
    tables.error = String(err).slice(0, 300);
  }

  return {
    created,
    offsiteConfigured: offsite.configured,
    uploaded: offsite.uploaded,
    uploadFailed: offsite.failed,
    pruned,
    tables,
  };
}
