import type { Prisma } from "@prisma/client";

/** A column of a table replaceRows writes, with the Postgres type its value is read back as. */
export interface ReplaceColumn {
  name: string;
  type: "text" | "integer" | "double precision" | "boolean" | "timestamp(3)" | "jsonb";
}

export interface ReplaceRowsSpec {
  table: string;
  /** The primary key column; it must be one of `columns`. */
  key: string;
  columns: readonly ReplaceColumn[];
  /**
   * Columns left out of the "did it change" comparison, but written whenever the row is. A rebuild
   * time (computedAt) goes here: compared, it would make every row differ on every run.
   */
  stampColumns?: readonly string[];
}

/** Rows per INSERT statement; one statement's JSON stays a few MB. */
const UPSERT_CHUNK = 5_000;

/**
 * Makes `table` hold exactly `rows`, inside the caller's transaction, writing only what changed:
 * a row whose values (stampColumns aside) are what is stored is left alone, a new or changed one is
 * inserted or updated (INSERT ... ON CONFLICT DO UPDATE ... WHERE IS DISTINCT FROM), and a stored
 * row not among `rows` is deleted.
 *
 * What it replaces, in walletRiskJob.ts and kolSideWalletsJob.ts: deleting every row and inserting
 * them all again, hourly. Readers saw the same table either way (one transaction), but each run left
 * a dead tuple and new index entries for every row, most of them unchanged (db-size audit
 * 2026-10-14, R6: 2.0 M inserts and 1.98 M deletes for a 34 k-row table). Table and column names
 * are constants from the callers, never input.
 */
export async function replaceRows(
  tx: Prisma.TransactionClient,
  spec: ReplaceRowsSpec,
  rows: readonly Record<string, unknown>[],
): Promise<{ written: number; deleted: number }> {
  const q = (name: string) => `"${name}"`;
  const stamps = new Set(spec.stampColumns ?? []);
  const names = spec.columns.map((c) => q(c.name)).join(", ");
  const recordType = spec.columns.map((c) => `${q(c.name)} ${c.type}`).join(", ");
  const updated = spec.columns.filter((c) => c.name !== spec.key);
  const compared = updated.filter((c) => !stamps.has(c.name));
  const upsert =
    `INSERT INTO ${q(spec.table)} (${names}) ` +
    `SELECT ${names} FROM jsonb_to_recordset($1::jsonb) AS r(${recordType}) ` +
    `ON CONFLICT (${q(spec.key)}) DO UPDATE SET ` +
    updated.map((c) => `${q(c.name)} = EXCLUDED.${q(c.name)}`).join(", ") +
    // A row compared as a whole: NULLs count as equal to NULLs, and any difference rewrites it.
    ` WHERE (${compared.map((c) => `${q(spec.table)}.${q(c.name)}`).join(", ")})` +
    ` IS DISTINCT FROM (${compared.map((c) => `EXCLUDED.${q(c.name)}`).join(", ")})`;

  let written = 0;
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK);
    written += await tx.$executeRawUnsafe(upsert, JSON.stringify(chunk));
  }
  const keys = rows.map((r) => String(r[spec.key]));
  // An anti-join against the key list, not `NOT (key = ANY($1))`: that form hashed the 77 k-key
  // array under a custom plan (tens of ms) but, once the prepared statement went generic, probed
  // it per row - 62 s for the same delete (database audit 2026-10-16, E3). NOT EXISTS over
  // unnest() hash-joins under either plan.
  const deleted = await tx.$executeRawUnsafe(
    `DELETE FROM ${q(spec.table)} t WHERE NOT EXISTS (` +
      `SELECT 1 FROM unnest($1::text[]) AS k(key) WHERE k.key = t.${q(spec.key)})`,
    keys,
  );
  return { written, deleted };
}
