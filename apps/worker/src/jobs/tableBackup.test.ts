// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  prisma,
  loadEnv,
  decodeTableBackup,
  encodeTableBackup,
  loadTableBackupData,
  pruneTableBackups,
  restoreTableBackup,
  saveTableBackup,
  sealTableBackup,
  uploadPendingTableBackups,
  weeklyTableBackupDue,
  TableBackupError,
  TABLE_BACKUP_FORMAT,
  TABLE_BACKUP_VERSION,
  type Env,
} from "@trenchscanner/core";
import { runModelBackupJob } from "./modelBackupJob.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const WALLET = "TableBackupTest1111111111111111111111111111";
const TAG = "TableBackupTest";

async function cleanUp() {
  await prisma.dataBackup.deleteMany({});
  await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  await prisma.user.deleteMany({ where: { walletAddress: WALLET } });
}

async function seed() {
  const user = await prisma.user.create({ data: { walletAddress: WALLET } });
  const filter = await prisma.userFilter.create({ data: { userId: user.id, name: `${TAG} filter` } });
  const entry = await prisma.burnCreditEntry.create({
    data: { wallet: WALLET, delta: 5, kind: "grant", note: `${TAG} grant` },
  });
  const token = await prisma.token.create({ data: { mintAddress: `${TAG}-coin`, symbol: "TBT" } });
  const alert = await prisma.curatedAlert.create({
    data: {
      tokenId: token.id,
      source: "heuristic-v1",
      confidence: 0.9,
      reasons: [],
      anchorPriceUsd: 0.0001,
      anchorMcapUsd: 100_000,
    },
  });
  return { user, filter, token, alert, entry };
}

describe.skipIf(!dbAvailable)("table backups", () => {
  afterEach(cleanUp);

  it("round-trips the irreplaceable tables and puts deleted rows back without touching live ones", async () => {
    await cleanUp();
    const { user, filter, token, alert, entry } = await seed();

    const saved = await saveTableBackup("manual", "test");
    expect(saved.rowCount).toBeGreaterThanOrEqual(4);
    const loaded = (await loadTableBackupData(saved.id))!;
    const payload = decodeTableBackup(loaded.data);
    expect(payload.tables.map((t) => t.name)).toContain("CuratedAlert");
    const users = payload.tables.find((t) => t.name === "User")!.rows as {
      id: string;
      walletAddress: string;
    }[];
    expect(users.some((u) => u.id === user.id && u.walletAddress === WALLET)).toBe(true);

    // The user goes (cascading to the filter), the ledger entry goes, and the alert's coin is swept.
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.burnCreditEntry.delete({ where: { id: entry.id } });
    await prisma.token.delete({ where: { id: token.id } });
    // A live row changes meanwhile: the restore must leave it as it is.
    const other = await prisma.user.create({ data: { walletAddress: WALLET } });
    await prisma.user.update({ where: { id: other.id }, data: { curatedModel: "kept" } });

    const result = await restoreTableBackup(payload);
    const byName = Object.fromEntries(result.tables.map((t) => [t.name, t]));
    // The old user row cannot come back next to a live row with the same wallet (unique), so it
    // is reported as already there; its filter points at the old id and is skipped as an
    // orphan; the ledger entry (keyed by wallet) comes straight back; the alert's coin is gone,
    // so it is skipped too.
    expect(byName.User!.inserted).toBe(0);
    expect(byName.UserFilter!.skipped).toBe(1);
    expect(byName.BurnCreditEntry!.inserted).toBe(1);
    expect(byName.CuratedAlert!.skipped).toBe(1);
    expect((await prisma.user.findUnique({ where: { id: other.id } }))!.curatedModel).toBe("kept");
    expect((await prisma.burnCreditEntry.findUnique({ where: { id: entry.id } }))!.delta).toBe(5);
    expect(await prisma.userFilter.count({ where: { id: filter.id } })).toBe(0);
    expect(await prisma.curatedAlert.count({ where: { id: alert.id } })).toBe(0);

    // With the parents back, the same file puts the children back.
    await prisma.user.delete({ where: { id: other.id } });
    await prisma.token.create({ data: { id: token.id, mintAddress: token.mintAddress, symbol: "TBT" } });
    const again = await restoreTableBackup(payload);
    const second = Object.fromEntries(again.tables.map((t) => [t.name, t]));
    expect(second.User!.inserted).toBe(1);
    expect(second.UserFilter!.inserted).toBe(1);
    expect(second.BurnCreditEntry!.inserted).toBe(0);
    expect(second.CuratedAlert!.inserted).toBe(1);
    expect((await prisma.userFilter.findUnique({ where: { id: filter.id } }))!.name).toBe(`${TAG} filter`);
    expect((await prisma.curatedAlert.findUnique({ where: { id: alert.id } }))!.confidence).toBe(0.9);
  });

  it("restores only the named tables, and a dry run changes nothing", async () => {
    await cleanUp();
    const { user, entry } = await seed();
    const saved = await saveTableBackup("manual", "test");
    const payload = decodeTableBackup((await loadTableBackupData(saved.id))!.data);
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.burnCreditEntry.delete({ where: { id: entry.id } });

    const dry = await restoreTableBackup(payload, { only: ["User", "BurnCreditEntry"], dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.tables.map((t) => t.name).sort()).toEqual(["BurnCreditEntry", "User"]);
    expect(dry.tables.find((t) => t.name === "User")!.inserted).toBeGreaterThanOrEqual(1);
    expect(await prisma.user.count({ where: { id: user.id } })).toBe(0);

    const real = await restoreTableBackup(payload, { only: ["BurnCreditEntry"] });
    expect(real.tables.map((t) => t.name)).toEqual(["BurnCreditEntry"]);
    expect(await prisma.burnCreditEntry.count({ where: { id: entry.id } })).toBe(1);
    // User was not named, so the deleted account stays deleted.
    expect(await prisma.user.count({ where: { id: user.id } })).toBe(0);
    await prisma.burnCreditEntry.delete({ where: { id: entry.id } });
  });

  it("refuses a file that was changed or is not a backup", () => {
    const good = sealTableBackup({
      format: TABLE_BACKUP_FORMAT,
      version: TABLE_BACKUP_VERSION,
      createdAt: new Date().toISOString(),
      kind: "manual",
      note: null,
      tables: [{ name: "User", rows: [] }],
    });
    expect(decodeTableBackup(encodeTableBackup(good).data).tables).toHaveLength(1);
    const edited = { ...good, tables: [{ name: "User", rows: [{ id: "x" }] }] };
    expect(() => decodeTableBackup(Buffer.from(JSON.stringify(edited)))).toThrow(TableBackupError);
    expect(() => decodeTableBackup(Buffer.from("{}"))).toThrow(TableBackupError);
  });

  it("is taken weekly by the backup job, copied to the bucket, and pruned past the keep count", async () => {
    await cleanUp();
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      calls.push(String(url));
      return new Response("", { status: 200 });
    };
    const env: Env = {
      ...loadEnv(),
      DATA_BACKUP_KEEP: 4,
      MODEL_BACKUP_S3_ENDPOINT: "https://bucket.test",
      MODEL_BACKUP_S3_BUCKET: "b",
      MODEL_BACKUP_S3_ACCESS_KEY_ID: "k",
      MODEL_BACKUP_S3_SECRET_ACCESS_KEY: "s",
    };
    expect(await weeklyTableBackupDue()).toBe(true);
    const first = await runModelBackupJob(env);
    const tables = first.tables as { created?: string; uploaded?: number };
    expect(tables.created).toBeTruthy();
    expect(await weeklyTableBackupDue()).toBe(false);
    expect((await runModelBackupJob(env)).tables).toMatchObject({ uploaded: 0 });

    // The bucket copy: the job's own upload ran without a fetch stub, so the row carries the
    // error; a pass with a reachable bucket clears it.
    const row = await prisma.dataBackup.findFirstOrThrow({ where: { kind: "weekly" } });
    expect(row.offsiteKey).toBeNull();
    const copies = await uploadPendingTableBackups(env, { fetchImpl });
    expect(copies).toEqual({ uploaded: 1, failed: 0, configured: true });
    expect(calls[0]).toMatch(/\/b\/trenchscanner\/table-backups\/trenchscanner-tables-/);
    expect((await prisma.dataBackup.findUniqueOrThrow({ where: { id: row.id } })).offsiteKey).toMatch(
      /^trenchscanner\/table-backups\//,
    );

    // Prune: the newest 4 weekly rows stay.
    for (let i = 0; i < 6; i++) {
      await prisma.dataBackup.create({
        data: {
          kind: "weekly",
          tables: [],
          rowCount: 0,
          data: Buffer.from(""),
          sizeBytes: 0,
          sha256: "",
          createdAt: new Date(Date.now() - (i + 2) * 7 * 86_400_000),
        },
      });
    }
    expect(await pruneTableBackups(4)).toBe(3);
    expect(await prisma.dataBackup.count({ where: { kind: "weekly" } })).toBe(4);
    expect(await prisma.dataBackup.count({ where: { id: row.id } })).toBe(1);
  });
});
