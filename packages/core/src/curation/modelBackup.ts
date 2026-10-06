import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import { Prisma, prisma } from "../db.js";
import type { Env } from "../config/env.js";
import { s3PutObject, type S3Config } from "../storage/s3.js";
import { liveCallRecords, loadCurrentLanes } from "./laneStore.js";
import type { CallRecord } from "./leaderboard.js";
import { COMBINER_MODEL_KINDS } from "./agreement.js";
import { firstNonFinite } from "./runGuard.js";

/**
 * Model backups: a self-contained snapshot of every model the contest is running, kept outside
 * the live tables (ModelBackup), restorable in one step from the Admin tab or from a downloaded
 * file after the database itself is lost.
 *
 * Why the live tables aren't enough: each training run retires every active model and ships new
 * ones, and the cleanup job strips a retired model's weights a week after it retires. A seat's
 * recipe (CuratorLane) outlives that, but a model's weights, cutoff and calibration don't - so
 * "the model that was doing well last month" was gone for good. A backup holds, per seat: the
 * active CuratorModel row whole (weights, cutoff, calibration, exam in evalMetrics), its lane
 * (recipe, lineage) and its 30-day live record; plus the default-model pick, the AI reviewer's
 * active playbook and the newest AI blend.
 *
 * The payload is plain JSON, gzipped. `integrity` is a sha256 of the rest of it, so a truncated or
 * hand-edited file is refused at import instead of half-restored.
 */

export const MODEL_BACKUP_FORMAT = "trenchscanner-model-backup";
export const MODEL_BACKUP_VERSION = 1;

export type ModelBackupKind = "weekly" | "manual" | "pre-restore" | "imported";

/** A weekly backup is due this long after the last one (an hour's slack for the hourly check). */
export const WEEKLY_BACKUP_INTERVAL_MS = 7 * 86_400_000 - 3_600_000;
/** Manual, pre-restore and imported backups are pruned after this long unless pinned. */
export const OTHER_BACKUP_RETENTION_DAYS = 90;
/** The live-record window stored with each seat - the leaderboard's. */
const RECORD_WINDOW_DAYS = 30;
/**
 * Most bytes a backup may unzip to. The import route takes a 64MB body, and gzip expands about a
 * thousandfold, so an uncapped gunzip of a crafted file could ask for tens of gigabytes and take
 * the API process down with it. A real backup is a few MB unzipped.
 */
const MAX_DECODED_BYTES = 512 * 1024 * 1024;

/**
 * Every write that replaces the active models (a training run storing its results, a restore)
 * takes this transaction-scoped advisory lock first, so the two can never interleave.
 */
export const CURATOR_MODEL_WRITE_LOCK = "curator-model-write";

export async function lockCuratorModelWrites(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${CURATOR_MODEL_WRITE_LOCK}))`;
}

/**
 * Interactive-transaction options for the model writes. Prisma's default timeout is 5 seconds; a
 * contest run writes a dozen models of up to a few hundred KB each, and on a busy or freshly
 * restarted database that commit can take longer - the run then rolled back whole and its hours of
 * training were thrown away.
 */
export const MODEL_WRITE_TX_OPTIONS = { maxWait: 30_000, timeout: 120_000 } as const;

export interface BackupModel {
  id: string;
  contestant: string | null;
  kind: string;
  params: unknown;
  trainingRows: number;
  trainingFrom: string;
  trainingTo: string;
  evalMetrics: unknown;
  activatedAt: string | null;
  createdAt: string;
}

export interface BackupLane {
  slot: string;
  name: string;
  description: string;
  recipe: unknown;
  generation: number;
  parentName: string | null;
  examScore: number | null;
  bornAt: string;
}

export interface ModelBackupPayload {
  format: typeof MODEL_BACKUP_FORMAT;
  version: number;
  createdAt: string;
  kind: ModelBackupKind;
  note: string | null;
  models: BackupModel[];
  lanes: BackupLane[];
  /** Each seat's live record over the 30 days before the backup (since its lane took the seat). */
  liveRecords: Record<string, CallRecord>;
  champion: { contestant: string; name: string; score: number | null; chosenAt: string } | null;
  aiPlaybook: {
    id: string;
    version: number;
    text: string;
    rationale: string | null;
    metrics: unknown;
  } | null;
  aiBlend: { params: unknown; metrics: unknown; createdAt: string } | null;
  /** sha256 (hex) of JSON.stringify of every field above, in this order. */
  integrity: string;
}

const sha256Hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

function integrityOf(payload: Omit<ModelBackupPayload, "integrity">): string {
  return sha256Hex(JSON.stringify(payload));
}

/** Adds the integrity hash to a payload body (captureModelSnapshot does this; tests and tools may too). */
export function sealBackupPayload(body: Omit<ModelBackupPayload, "integrity">): ModelBackupPayload {
  return { ...body, integrity: integrityOf(body) };
}

/**
 * Reads the running models into a payload. One repeatable-read transaction, so a training run
 * committing halfway through can't leave the backup with half of one generation and half of the
 * next. Null when there is no active model to back up.
 */
export async function captureModelSnapshot(
  kind: ModelBackupKind,
  note: string | null = null,
  now = new Date(),
): Promise<ModelBackupPayload | null> {
  const snapshot = await prisma.$transaction(
    async (tx) => {
      const models = await tx.curatorModel.findMany({
        where: { status: "active" },
        orderBy: { createdAt: "asc" },
      });
      const lanes = await tx.curatorLane.findMany({
        where: { retiredAt: null },
        orderBy: { bornAt: "desc" },
      });
      const champion = await tx.curatorChampion.findFirst({ orderBy: { chosenAt: "desc" } });
      const playbook = await tx.aiPlaybook.findFirst({
        where: { status: "active" },
        orderBy: { createdAt: "desc" },
      });
      const blend = await tx.aiBlendModel.findFirst({ orderBy: { createdAt: "desc" } });
      return { models, lanes, champion, playbook, blend };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, ...MODEL_WRITE_TX_OPTIONS },
  );
  if (snapshot.models.length === 0) return null;

  // One current lane per slot, newest first - the same rule as loadCurrentLanes.
  const seen = new Set<string>();
  const lanes = snapshot.lanes.filter((l) => (seen.has(l.slot) ? false : (seen.add(l.slot), true)));
  const slots = [...new Set(snapshot.models.flatMap((m) => (m.contestant ? [m.contestant] : [])))];
  const since = new Date(now.getTime() - RECORD_WINDOW_DAYS * 86_400_000);
  const records = await liveCallRecords(slots, since, await loadCurrentLanes()).catch(
    () => new Map<string, CallRecord>(),
  );

  const body: Omit<ModelBackupPayload, "integrity"> = {
    format: MODEL_BACKUP_FORMAT,
    version: MODEL_BACKUP_VERSION,
    createdAt: now.toISOString(),
    kind,
    note,
    models: snapshot.models.map((m) => ({
      id: m.id,
      contestant: m.contestant,
      kind: m.kind,
      params: m.params,
      trainingRows: m.trainingRows,
      trainingFrom: m.trainingFrom.toISOString(),
      trainingTo: m.trainingTo.toISOString(),
      evalMetrics: m.evalMetrics,
      activatedAt: m.activatedAt?.toISOString() ?? null,
      createdAt: m.createdAt.toISOString(),
    })),
    lanes: lanes.map((l) => ({
      slot: l.slot,
      name: l.name,
      description: l.description,
      recipe: l.recipe,
      generation: l.generation,
      parentName: l.parentName,
      examScore: l.examScore,
      bornAt: l.bornAt.toISOString(),
    })),
    liveRecords: Object.fromEntries(records),
    champion: snapshot.champion
      ? {
          contestant: snapshot.champion.contestant,
          name: snapshot.champion.name,
          score: snapshot.champion.score,
          chosenAt: snapshot.champion.chosenAt.toISOString(),
        }
      : null,
    aiPlaybook: snapshot.playbook
      ? {
          id: snapshot.playbook.id,
          version: snapshot.playbook.version,
          text: snapshot.playbook.text,
          rationale: snapshot.playbook.rationale,
          metrics: snapshot.playbook.metrics,
        }
      : null,
    aiBlend: snapshot.blend
      ? {
          params: snapshot.blend.params,
          metrics: snapshot.blend.metrics,
          createdAt: snapshot.blend.createdAt.toISOString(),
        }
      : null,
  };
  return sealBackupPayload(body);
}

export function encodeBackup(payload: ModelBackupPayload): { data: Buffer; sha256: string } {
  const data = gzipSync(Buffer.from(JSON.stringify(payload), "utf8"));
  return { data, sha256: sha256Hex(data) };
}

/** Parses a backup file - gzipped (as downloaded) or plain JSON - and checks it end to end. */
export function decodeBackup(data: Uint8Array): ModelBackupPayload {
  const buf = Buffer.from(data);
  let text: string;
  try {
    text = (
      buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf, { maxOutputLength: MAX_DECODED_BYTES }) : buf
    ).toString("utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") {
      throw new ModelBackupError("the file unzips to more than this build will read - it is not a backup");
    }
    throw new ModelBackupError("the file is not a readable backup (gzip failed - truncated?)");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ModelBackupError("the file is not a backup (not JSON)");
  }
  return validateBackupPayload(parsed);
}

export class ModelBackupError extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** An ISO-8601 timestamp that parses: every date in a backup is one, and `new Date` of anything else is NaN. */
const isoDate = z.string().refine((v) => !Number.isNaN(Date.parse(v)), "is not a timestamp");
const jsonValue: z.ZodType<unknown> = z.unknown();

/**
 * The full shape of a payload, every field the restore writes. The integrity hash only proves the
 * file wasn't changed in transit - anyone can seal a payload - so a field the schema didn't check
 * reached Prisma as-is, and a wrong one threw a TypeError (a 500 to the admin) or a validation
 * error inside the restore transaction, after the pre-restore safety backup had already been taken.
 */
const backupModelSchema = z.object({
  id: z.string().min(1),
  contestant: z.string().min(1).nullable(),
  kind: z.string().min(1),
  params: z.record(z.string(), jsonValue),
  trainingRows: z.number().int().nonnegative(),
  trainingFrom: isoDate,
  trainingTo: isoDate,
  evalMetrics: jsonValue.optional(),
  activatedAt: isoDate.nullable().optional(),
  createdAt: isoDate.optional(),
});
const backupLaneSchema = z.object({
  slot: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  recipe: jsonValue,
  generation: z.number().int(),
  parentName: z.string().nullable().optional(),
  examScore: z.number().nullable().optional(),
  bornAt: isoDate,
});
const backupPayloadSchema = z.object({
  format: z.literal(MODEL_BACKUP_FORMAT),
  version: z.number().int(),
  createdAt: isoDate,
  kind: z.string().min(1),
  note: z.string().nullable().optional(),
  models: z.array(backupModelSchema).min(1, "the backup holds no models"),
  lanes: z.array(backupLaneSchema),
  liveRecords: z.record(z.string(), z.record(z.string(), jsonValue)),
  champion: z
    .object({
      contestant: z.string(),
      name: z.string(),
      score: z.number().nullable(),
      chosenAt: isoDate,
    })
    .nullable()
    .optional(),
  aiPlaybook: z
    .object({
      id: z.string(),
      version: z.number().int(),
      text: z.string(),
      rationale: z.string().nullable().optional(),
      metrics: jsonValue.optional(),
    })
    .nullable()
    .optional(),
  aiBlend: z.object({ params: jsonValue, metrics: jsonValue, createdAt: isoDate }).nullable().optional(),
  integrity: z.string(),
});
const membersSchema = z.array(z.object({ contestant: z.string().min(1) }));

/** Checks shape and integrity. Throws ModelBackupError with what is wrong. */
export function validateBackupPayload(value: unknown): ModelBackupPayload {
  if (!isObject(value) || value.format !== MODEL_BACKUP_FORMAT) {
    throw new ModelBackupError("not a TrenchScanner model backup");
  }
  if (typeof value.version !== "number" || value.version > MODEL_BACKUP_VERSION) {
    throw new ModelBackupError(
      `backup format version ${String(value.version)} is newer than this build reads`,
    );
  }
  const { integrity, ...rest } = value;
  if (
    typeof integrity !== "string" ||
    integrityOf(rest as Omit<ModelBackupPayload, "integrity">) !== integrity
  ) {
    throw new ModelBackupError("the backup's integrity check failed - the file was changed or cut short");
  }
  const parsed = backupPayloadSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? issue.path.join(".") : "the backup";
    throw new ModelBackupError(`the backup is malformed: ${where} ${issue?.message ?? "is invalid"}`);
  }
  const payload = parsed.data;
  const seats = new Set(payload.models.flatMap((m) => (m.contestant ? [m.contestant] : [])));
  for (const m of payload.models) {
    // The training path never ships a model with a NaN or infinite weight (see runGuard); a file
    // can carry one (NaN serialises as null, which JSON.parse hands back as null - caught by the
    // record check above - but an Infinity written by hand is a number). Such a seat would score
    // every candidate NaN and fall silent with nothing in the log.
    const bad = firstNonFinite(m.params);
    if (bad !== null) {
      throw new ModelBackupError(`${m.contestant ?? m.id} has a weight that is not a number (${bad})`);
    }
    if (!COMBINER_MODEL_KINDS.includes(m.kind)) continue;
    const members = membersSchema.safeParse(m.params.members ?? []);
    if (!members.success) throw new ModelBackupError(`${m.contestant}'s members list is malformed`);
    const missing = members.data.filter((x) => !seats.has(x.contestant));
    if (missing.length > 0) {
      throw new ModelBackupError(
        `${m.contestant}'s members ${missing.map((x) => x.contestant).join(", ")} are not in the backup`,
      );
    }
  }
  return payload as unknown as ModelBackupPayload;
}

/** One seat in a backup, as the Admin tab lists it. */
export interface BackupSeat {
  seat: string;
  /** The lane's name when the backup has one, else the name its exam was stored under. */
  name: string;
  kind: string;
  /** Emission cutoff; null for kinds without one (rules). */
  threshold: number | null;
  trainingRows: number;
  trainedAt: string;
  exam: CallRecord | null;
  live: CallRecord | null;
  /** Seats a consensus or blend is built from - restoring it brings them too. */
  members: string[];
}

export function describeBackupSeats(payload: ModelBackupPayload): BackupSeat[] {
  const laneName = new Map(payload.lanes.map((l) => [l.slot, l.name]));
  return payload.models.flatMap((m) => {
    if (!m.contestant) return [];
    const params = (m.params ?? {}) as { threshold?: unknown; members?: { contestant: string }[] };
    const metrics = (m.evalMetrics ?? {}) as { exam?: CallRecord; contestantName?: string };
    return [
      {
        seat: m.contestant,
        name: laneName.get(m.contestant) ?? metrics.contestantName ?? m.contestant,
        kind: m.kind,
        threshold: typeof params.threshold === "number" ? params.threshold : null,
        trainingRows: m.trainingRows,
        trainedAt: m.trainingTo,
        exam: metrics.exam ?? null,
        live: payload.liveRecords[m.contestant] ?? null,
        members: Array.isArray(params.members) ? params.members.map((x) => x.contestant) : [],
      },
    ];
  });
}

/**
 * A backup cut down to some seats: their models and lanes, plus the members of any consensus or
 * blend among them (its params point at those members, so it can't run without them). The AI
 * playbook and blend stay out - they belong to the whole field, and a whole-backup restore carries
 * them. Re-sealed, so the result is a backup file in its own right.
 */
export function selectSeats(payload: ModelBackupPayload, seats: readonly string[]): ModelBackupPayload {
  const wanted = new Set(seats);
  for (const m of payload.models) {
    if (!m.contestant || !wanted.has(m.contestant)) continue;
    const members = (m.params as { members?: { contestant: string }[] }).members ?? [];
    for (const x of members) wanted.add(x.contestant);
  }
  const models = payload.models.filter((m) => m.contestant !== null && wanted.has(m.contestant));
  if (models.length === 0) throw new ModelBackupError(`none of ${seats.join(", ")} is in this backup`);
  const { integrity: _integrity, ...rest } = payload;
  return sealBackupPayload({
    ...rest,
    note: [payload.note, `Selected: ${[...wanted].join(", ")}`].filter(Boolean).join(" · "),
    models,
    lanes: payload.lanes.filter((l) => wanted.has(l.slot)),
    liveRecords: Object.fromEntries(Object.entries(payload.liveRecords).filter(([k]) => wanted.has(k))),
    aiPlaybook: null,
    aiBlend: null,
  });
}

/**
 * The running models as a backup file, without storing it - "export this model now". All seats
 * when `seats` is empty. Null when nothing is running.
 */
export async function exportRunningModels(seats: readonly string[] = []): Promise<ModelBackupPayload | null> {
  const payload = await captureModelSnapshot("manual", "Exported from the running models");
  if (!payload) return null;
  return seats.length > 0 ? selectSeats(payload, seats) : payload;
}

export interface ModelBackupSummary {
  id: string;
  createdAt: Date;
  kind: string;
  note: string | null;
  pinned: boolean;
  modelCount: number;
  sizeBytes: number;
  sha256: string;
  offsiteKey: string | null;
  offsiteAt: Date | null;
  offsiteError: string | null;
  restoredAt: Date | null;
}

export const BACKUP_SUMMARY_SELECT = {
  id: true,
  createdAt: true,
  kind: true,
  note: true,
  pinned: true,
  modelCount: true,
  sizeBytes: true,
  sha256: true,
  offsiteKey: true,
  offsiteAt: true,
  offsiteError: true,
  restoredAt: true,
} as const;

export async function storeBackupPayload(
  payload: ModelBackupPayload,
  kind: ModelBackupKind,
  note: string | null,
): Promise<ModelBackupSummary> {
  const { data, sha256 } = encodeBackup(payload);
  return prisma.modelBackup.create({
    data: { kind, note, modelCount: payload.models.length, data, sizeBytes: data.length, sha256 },
    select: BACKUP_SUMMARY_SELECT,
  });
}

/** Snapshots the running models and stores the backup. Null when no model is active yet. */
export async function saveModelBackup(
  kind: ModelBackupKind,
  note: string | null = null,
): Promise<ModelBackupSummary | null> {
  const payload = await captureModelSnapshot(kind, note);
  if (!payload) return null;
  return storeBackupPayload(payload, kind, note);
}

export async function listModelBackups(limit = 100): Promise<ModelBackupSummary[]> {
  return prisma.modelBackup.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    select: BACKUP_SUMMARY_SELECT,
  });
}

/** A stored backup's bytes, checked against the hash written with them. */
export async function loadBackupData(id: string): Promise<{ data: Buffer; row: ModelBackupSummary } | null> {
  const row = await prisma.modelBackup.findUnique({
    where: { id },
    select: { ...BACKUP_SUMMARY_SELECT, data: true },
  });
  if (!row) return null;
  const { data, ...summary } = row;
  const buf = Buffer.from(data);
  if (sha256Hex(buf) !== row.sha256) {
    throw new ModelBackupError("the stored backup does not match its checksum - it is damaged");
  }
  return { data: buf, row: summary };
}

export function backupFileName(row: { createdAt: Date; kind: string; id: string }): string {
  const stamp = row.createdAt
    .toISOString()
    .replace(/[:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `trenchscanner-models-${stamp}-${row.kind}-${row.id}.json.gz`;
}

export interface RestoreResult {
  backupId: string;
  /** The seats put back. */
  seats: string[];
  safetyBackupId: string | null;
  models: number;
  lanesRestored: number;
  playbookRestored: boolean;
  blendRestored: boolean;
}

/**
 * Puts a backup's models back in charge. First snapshots what is running now (a "pre-restore"
 * backup, so a restore can itself be undone), then in one transaction under the model-write lock:
 *  - every active model of a seat the backup covers retires, and the backup's model for it goes
 *    live as a new row (consensus and blend rows re-pointed at their members' new ids, so the
 *    roster's "trained beside" check passes);
 *  - each seat's lane goes back to the backed-up recipe, with its original name and birth time,
 *    so its live record under that name counts again (a seat already on that lane is untouched);
 *  - the AI reviewer's playbook and blend come back too, when the backup has them and they differ.
 *
 * The next training run retrains each restored recipe on fresh data, exactly as it would have
 * the original - the restore brings back the recipes for good and the weights until then.
 */
export async function restoreModelBackup(
  backupId: string,
  /** `seats`: restore only these (see selectSeats); empty or absent restores the whole backup. */
  opts: { now?: Date; actor?: string; seats?: readonly string[] } = {},
): Promise<RestoreResult> {
  const loaded = await loadBackupData(backupId);
  if (!loaded) throw new ModelBackupError("no such backup");
  const whole = decodeBackup(loaded.data);
  const payload = opts.seats && opts.seats.length > 0 ? selectSeats(whole, opts.seats) : whole;
  const now = opts.now ?? new Date();
  const label = `backup of ${payload.createdAt.slice(0, 16).replace("T", " ")} UTC`;

  const safetyNote = `Taken automatically before restoring the ${label}${opts.actor ? ` (by ${opts.actor})` : ""}`;
  const safetyPayload = await captureModelSnapshot("pre-restore", safetyNote);
  const safety = safetyPayload ? await storeBackupPayload(safetyPayload, "pre-restore", safetyNote) : null;
  const safetyIds = new Set((safetyPayload?.models ?? []).map((m) => m.id));

  const result = await restoreUnderLock(backupId, payload, safetyIds, label, now).catch(
    async (err: unknown) => {
      // Nothing was restored, so the snapshot taken to undo it guards nothing: drop it rather than
      // leave a multi-megabyte "pre-restore" row per retry until the 90-day prune.
      if (safety) await prisma.modelBackup.delete({ where: { id: safety.id } }).catch(() => {});
      throw err;
    },
  );

  return {
    backupId,
    seats: payload.models.flatMap((m) => (m.contestant ? [m.contestant] : [])),
    safetyBackupId: safety?.id ?? null,
    ...result,
  };
}

function restoreUnderLock(
  backupId: string,
  payload: ModelBackupPayload,
  safetyIds: Set<string>,
  label: string,
  now: Date,
) {
  return prisma.$transaction(async (tx) => {
    await lockCuratorModelWrites(tx);

    // The safety backup was taken outside this lock, so a training run that committed in between
    // would be retired here without the "undo" backup holding it. The active set has to be
    // exactly what was snapshotted; otherwise the admin retries and gets a fresh snapshot.
    const active = await tx.curatorModel.findMany({ where: { status: "active" }, select: { id: true } });
    if (active.length !== safetyIds.size || active.some((m) => !safetyIds.has(m.id))) {
      throw new ModelBackupError("the running models changed while the restore was starting - try again");
    }

    // Lanes: only where the seat isn't already on the backed-up one.
    let lanesRestored = 0;
    for (const lane of payload.lanes) {
      const current = await tx.curatorLane.findFirst({
        where: { slot: lane.slot, retiredAt: null },
        orderBy: { bornAt: "desc" },
      });
      if (current && current.name === lane.name && current.bornAt.toISOString() === lane.bornAt) continue;
      await tx.curatorLane.updateMany({
        where: { slot: lane.slot, retiredAt: null },
        data: { retiredAt: now, retiredReason: `Restored ${lane.name} from the ${label}` },
      });
      await tx.curatorLane.create({
        data: {
          slot: lane.slot,
          name: lane.name,
          description: lane.description,
          recipe: lane.recipe as Prisma.InputJsonValue,
          generation: lane.generation,
          parentName: lane.parentName,
          examScore: lane.examScore,
          bornAt: new Date(lane.bornAt),
        },
      });
      lanesRestored++;
    }

    // Models: members before the consensus and blend that point at them.
    const dependent = (kind: string) => COMBINER_MODEL_KINDS.includes(kind);
    const ordered = [...payload.models].sort((a, b) => Number(dependent(a.kind)) - Number(dependent(b.kind)));
    const seats = ordered.flatMap((m) => (m.contestant ? [m.contestant] : []));
    await tx.curatorModel.updateMany({
      where: { status: { in: ["active", "candidate"] }, contestant: { in: seats } },
      data: { status: "retired", retiredAt: now },
    });
    const ids = new Map<string, string>();
    for (const m of ordered) {
      let params = m.params as Record<string, unknown>;
      if (dependent(m.kind) && Array.isArray(params.members)) {
        params = {
          ...params,
          members: (params.members as { contestant: string }[]).map((x) => ({
            ...x,
            modelId: ids.get(x.contestant) ?? "",
          })),
        };
      }
      const created = await tx.curatorModel.create({
        data: {
          contestant: m.contestant,
          kind: m.kind,
          params: params as Prisma.InputJsonValue,
          trainingRows: m.trainingRows,
          trainingFrom: new Date(m.trainingFrom),
          trainingTo: new Date(m.trainingTo),
          evalMetrics: (m.evalMetrics ?? {}) as Prisma.InputJsonValue,
          status: "active",
          activatedAt: now,
        },
        select: { id: true },
      });
      if (m.contestant) ids.set(m.contestant, created.id);
    }

    let playbookRestored = false;
    if (payload.aiPlaybook) {
      const active = await tx.aiPlaybook.findFirst({
        where: { status: "active" },
        orderBy: { createdAt: "desc" },
      });
      if (!active || active.text !== payload.aiPlaybook.text) {
        const top = await tx.aiPlaybook.aggregate({ _max: { version: true } });
        await tx.aiPlaybook.updateMany({
          where: { status: "active" },
          data: { status: "retired", decidedAt: now },
        });
        await tx.aiPlaybook.create({
          data: {
            version: (top._max.version ?? 0) + 1,
            status: "active",
            text: payload.aiPlaybook.text,
            rationale: `Restored version ${payload.aiPlaybook.version} from the ${label}`,
            parentId: active?.id ?? null,
            decidedAt: now,
            ...(payload.aiPlaybook.metrics !== null && payload.aiPlaybook.metrics !== undefined
              ? { metrics: payload.aiPlaybook.metrics as Prisma.InputJsonValue }
              : {}),
          },
        });
        playbookRestored = true;
      }
    }

    let blendRestored = false;
    if (payload.aiBlend) {
      const newest = await tx.aiBlendModel.findFirst({ orderBy: { createdAt: "desc" } });
      if (!newest || JSON.stringify(newest.params) !== JSON.stringify(payload.aiBlend.params)) {
        await tx.aiBlendModel.create({
          data: {
            params: payload.aiBlend.params as Prisma.InputJsonValue,
            metrics: payload.aiBlend.metrics as Prisma.InputJsonValue,
          },
        });
        blendRestored = true;
      }
    }

    await tx.modelBackup.update({ where: { id: backupId }, data: { restoredAt: now } });
    return { models: ordered.length, lanesRestored, playbookRestored, blendRestored };
  }, MODEL_WRITE_TX_OPTIONS);
}

/** Whether the weekly backup is due: none yet, or the newest is a week old. */
export async function weeklyBackupDue(now = new Date()): Promise<boolean> {
  const newest = await prisma.modelBackup.findFirst({
    where: { kind: "weekly" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return !newest || now.getTime() - newest.createdAt.getTime() >= WEEKLY_BACKUP_INTERVAL_MS;
}

/**
 * Keeps the newest `keepWeeks` weekly backups and every other kind for 90 days; pinned backups
 * stay whatever their age. Off-site copies are never deleted from here - the bucket's own
 * lifecycle rules decide those.
 */
export async function pruneModelBackups(keepWeeks: number, now = new Date()): Promise<number> {
  const surplus = await prisma.modelBackup.findMany({
    where: { kind: "weekly", pinned: false },
    orderBy: { createdAt: "desc" },
    skip: keepWeeks,
    select: { id: true },
  });
  const weekly = await prisma.modelBackup.deleteMany({ where: { id: { in: surplus.map((r) => r.id) } } });
  const others = await prisma.modelBackup.deleteMany({
    where: {
      kind: { not: "weekly" },
      pinned: false,
      createdAt: { lt: new Date(now.getTime() - OTHER_BACKUP_RETENTION_DAYS * 86_400_000) },
    },
  });
  return weekly.count + others.count;
}

/** The off-site bucket from MODEL_BACKUP_S3_*, or null when it isn't fully configured. */
export function offsiteConfig(env: Env): (S3Config & { prefix: string }) | null {
  const { MODEL_BACKUP_S3_ENDPOINT: endpoint, MODEL_BACKUP_S3_BUCKET: bucket } = env;
  const { MODEL_BACKUP_S3_ACCESS_KEY_ID: accessKeyId, MODEL_BACKUP_S3_SECRET_ACCESS_KEY: secretAccessKey } =
    env;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    endpoint,
    bucket,
    region: env.MODEL_BACKUP_S3_REGION || "auto",
    accessKeyId,
    secretAccessKey,
    prefix: env.MODEL_BACKUP_S3_PREFIX,
  };
}

/**
 * Copies backups that have no off-site copy yet (newest 30 days, oldest first) to the bucket.
 * A failure is recorded on the row and retried on the next pass.
 */
export async function uploadPendingBackups(
  env: Env,
  opts: { now?: Date; fetchImpl?: typeof fetch; limit?: number } = {},
): Promise<{ uploaded: number; failed: number; configured: boolean }> {
  const cfg = offsiteConfig(env);
  if (!cfg) return { uploaded: 0, failed: 0, configured: false };
  const now = opts.now ?? new Date();
  const pending = await prisma.modelBackup.findMany({
    where: { offsiteKey: null, createdAt: { gte: new Date(now.getTime() - 30 * 86_400_000) } },
    // Never-tried rows first: a backup the bucket keeps refusing would otherwise sort ahead of
    // every newer one, and with five such rows no new backup ever left the database.
    orderBy: [{ offsiteError: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    take: opts.limit ?? 5,
    select: { id: true },
  });
  let uploaded = 0;
  let failed = 0;
  for (const { id } of pending) {
    try {
      const loaded = await loadBackupData(id);
      if (!loaded) continue;
      const key = `${cfg.prefix}model-backups/${backupFileName(loaded.row)}`;
      await s3PutObject(cfg, key, loaded.data, "application/gzip", opts.fetchImpl);
      await prisma.modelBackup.update({
        where: { id },
        data: { offsiteKey: key, offsiteAt: new Date(), offsiteError: null },
      });
      uploaded++;
    } catch (err) {
      failed++;
      await prisma.modelBackup
        .update({ where: { id }, data: { offsiteError: String(err).slice(0, 500) } })
        .catch(() => undefined);
    }
  }
  return { uploaded, failed, configured: true };
}
