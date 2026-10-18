import type { Env } from "../config/env.js";
import { s3GetObject, s3ListObjects, s3PresignedGetUrl, type S3Config } from "../storage/s3.js";

/**
 * The nightly full-database dumps (scripts/db-backup/backup.sh) as Admin > Backups shows them:
 * the API lists the bucket and hands an admin a short-lived signed link, so an 8 GB file goes
 * from the bucket to the browser without passing through this process. The layout is backup.sh's
 * (common.sh):
 *   <prefix>db-dumps/trenchscanner-<UTC stamp>.dump      pg_dump custom format, zstd-compressed
 *   <prefix>db-dumps/trenchscanner-<UTC stamp>.sha256    written only once the dump is whole
 *   <prefix>db-dumps-pre-restore/...                     restore.sh's copy before a --replace
 * A dump with no .sha256 beside it is incomplete and is never listed, as in restore.sh.
 */

export type DbDumpKind = "nightly" | "pre-restore";

export interface DbDump {
  /** The file name, e.g. trenchscanner-20261018T023000Z.dump; what the download route takes. */
  name: string;
  kind: DbDumpKind;
  takenAt: string | null;
  sizeBytes: number;
}

export interface DbDumpDownload {
  name: string;
  url: string;
  sha256: string;
  sizeBytes: number;
  expiresAt: string;
}

export class DbDumpError extends Error {}

/** How long a download link works. A download already running when it expires carries on. */
export const DB_DUMP_LINK_SECONDS = 15 * 60;

const NAME_RE = /^trenchscanner-(\d{8}T\d{6}Z)\.dump$/;

export function dbDumpConfig(env: Env): (S3Config & { prefix: string }) | null {
  const { DB_DUMP_S3_ENDPOINT: endpoint, DB_DUMP_S3_BUCKET: bucket } = env;
  const { DB_DUMP_S3_ACCESS_KEY_ID: accessKeyId, DB_DUMP_S3_SECRET_ACCESS_KEY: secretAccessKey } = env;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    endpoint,
    bucket,
    region: env.DB_DUMP_S3_REGION || "auto",
    accessKeyId,
    secretAccessKey,
    prefix: env.DB_DUMP_S3_PREFIX,
  };
}

/** "20261018T023000Z" -> its ISO time, or null for a name that isn't one. */
export function dumpStampTime(name: string): string | null {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const s = m[1]!;
  const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

const dirOf = (prefix: string, kind: DbDumpKind) =>
  `${prefix}${kind === "nightly" ? "db-dumps/" : "db-dumps-pre-restore/"}`;

/** The complete dumps of both folders, newest first, each with the key it lives under. */
async function completeDumps(
  cfg: S3Config & { prefix: string },
  fetchImpl?: typeof fetch,
): Promise<(DbDump & { key: string })[]> {
  const out: (DbDump & { key: string })[] = [];
  for (const kind of ["nightly", "pre-restore"] as const) {
    const dir = dirOf(cfg.prefix, kind);
    const objects = await s3ListObjects(cfg, dir, fetchImpl);
    const keys = new Set(objects.map((o) => o.key));
    for (const o of objects) {
      const name = o.key.slice(dir.length);
      if (!NAME_RE.test(name) || !keys.has(`${dir}${name.replace(/\.dump$/, ".sha256")}`)) continue;
      out.push({ key: o.key, name, kind, takenAt: dumpStampTime(name), sizeBytes: o.sizeBytes });
    }
  }
  return out.sort((a, b) => (a.takenAt ?? "").localeCompare(b.takenAt ?? "")).reverse();
}

export async function listDbDumps(
  cfg: S3Config & { prefix: string },
  fetchImpl?: typeof fetch,
): Promise<DbDump[]> {
  return (await completeDumps(cfg, fetchImpl)).map(({ key: _key, ...d }) => d);
}

/**
 * A signed link to one complete dump, with the sha256 backup.sh recorded for it. Only a name the
 * listing shows is accepted, so the link can't be pointed at anything else in the bucket.
 */
export async function dbDumpDownload(
  cfg: S3Config & { prefix: string },
  name: string,
  fetchImpl?: typeof fetch,
  now = new Date(),
): Promise<DbDumpDownload | null> {
  if (!NAME_RE.test(name)) return null;
  const dump = (await completeDumps(cfg, fetchImpl)).find((d) => d.name === name);
  if (!dump) return null;
  const shaFile = (await s3GetObject(cfg, dump.key.replace(/\.dump$/, ".sha256"), fetchImpl)).toString(
    "utf8",
  );
  const sha256 = /^([0-9a-f]{64})\b/.exec(shaFile.trim())?.[1];
  if (!sha256) throw new DbDumpError(`${name}'s .sha256 is not a sha256; run restore.sh verify ${name}`);
  return {
    name,
    url: s3PresignedGetUrl(cfg, dump.key, DB_DUMP_LINK_SECONDS, name, now),
    sha256,
    sizeBytes: dump.sizeBytes,
    expiresAt: new Date(now.getTime() + DB_DUMP_LINK_SECONDS * 1000).toISOString(),
  };
}
