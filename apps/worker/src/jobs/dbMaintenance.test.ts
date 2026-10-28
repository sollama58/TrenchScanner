// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import { findInvalidIndexes, REINDEX_TARGETS, reindexBloated } from "./dbMaintenance.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

describe("REINDEX_TARGETS", () => {
  it("is the same list as scripts/reindex-bloat.sql, the by-hand rebuild", () => {
    const sql = readFileSync(new URL("../../../../scripts/reindex-bloat.sql", import.meta.url), "utf8");
    const inFile = [...sql.matchAll(/^REINDEX INDEX CONCURRENTLY "([^"]+)";/gm)].map((m) => m[1]);
    expect(inFile).toEqual([...REINDEX_TARGETS]);
  });
});

describe.skipIf(!dbAvailable)("db maintenance", () => {
  const TABLE = "DbMaintenanceTest";
  const INDEX = "DbMaintenanceTest_v_idx";

  /** A unique index built CONCURRENTLY over duplicate values fails and stays behind INVALID. */
  async function leaveInvalidIndex(name: string) {
    await prisma
      .$executeRawUnsafe(`CREATE UNIQUE INDEX CONCURRENTLY "${name}" ON "${TABLE}" (dup)`)
      .catch(() => undefined);
  }

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${TABLE}"`);
    await prisma.$executeRawUnsafe(`CREATE TABLE "${TABLE}" (id serial PRIMARY KEY, v int, dup int)`);
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${TABLE}" (v, dup) SELECT g, 1 FROM generate_series(1, 2000) g`,
    );
    await prisma.$executeRawUnsafe(`CREATE INDEX "${INDEX}" ON "${TABLE}" (v)`);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${TABLE}"`);
  });

  it("finds an index a failed CONCURRENTLY build left invalid", async () => {
    expect(await findInvalidIndexes()).not.toContainEqual(expect.objectContaining({ table: TABLE }));
    await leaveInvalidIndex("DbMaintenanceTest_dup_key");
    expect(await findInvalidIndexes()).toContainEqual({ table: TABLE, index: "DbMaintenanceTest_dup_key" });
    await prisma.$executeRawUnsafe(`DROP INDEX "DbMaintenanceTest_dup_key"`);
    expect(await findInvalidIndexes()).not.toContainEqual(expect.objectContaining({ table: TABLE }));
  });

  it("rebuilds its targets, dropping what a cut-off rebuild left behind first", async () => {
    await leaveInvalidIndex(`${INDEX}_ccnew`);
    const result = await reindexBloated({ diskAlertMb: 10_000_000, targets: [INDEX, "NoSuchIndex_idx"] });
    expect(result.droppedLeftovers).toEqual([`${INDEX}_ccnew`]);
    expect(result.rebuilt).toHaveLength(1);
    expect(result.rebuilt[0]).toMatch(new RegExp(`^${INDEX} \\d+->\\d+ MB$`));
    expect(result.skipped).toEqual(["NoSuchIndex_idx (no such index)"]);
    expect(await findInvalidIndexes()).not.toContainEqual(expect.objectContaining({ table: TABLE }));
  });

  it("rebuilds nothing without room under the disk line, or with the line off", async () => {
    // The test database itself is over 1 MB, so a 1 MB line leaves no headroom at all.
    const tight = await reindexBloated({ diskAlertMb: 1, targets: [INDEX] });
    expect(tight.rebuilt).toEqual([]);
    expect(tight.skipped[0]).toMatch(/under the disk line/);
    const off = await reindexBloated({ diskAlertMb: 0, targets: [INDEX] });
    expect(off).toMatchObject({ rebuilt: [], skipped: [`${INDEX} (DB_DISK_ALERT_MB is off)`] });
  });
});
