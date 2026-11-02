#!/usr/bin/env node
// Invalid indexes around `prisma migrate deploy` - used by scripts/migrate-deploy.sh.
//
// A `CREATE INDEX CONCURRENTLY` that is cut off (a deploy superseded while it built, a statement
// timeout, a restart) leaves its index INVALID: written on every insert, used by no query, and
// skipped by the migration's own re-run because `IF NOT EXISTS` sees a row for the name. The
// nightly cleanup only reports one (dbMaintenance.ts findInvalidIndexes). On 2026-11-02 the
// kol-side-wallets index from #1206 sat INVALID in production that way, at 627 MB, while the
// statement it was built for stayed the costliest in the database (full audit 2026-11-02, DB-1).
//
//   list                 the schema's invalid indexes not being built right now, one name a line
//   drop NAME...         DROP INDEX CONCURRENTLY IF EXISTS each (never inside a transaction)
//   recreate NAME...     run the migration's own `CREATE INDEX CONCURRENTLY IF NOT EXISTS "NAME"`
//                        statement again for each name a migration file defines that way. A name
//                        built any other way (a schema.prisma @@index, a plain CREATE INDEX) is
//                        reported for the operator and left out: its migration is already
//                        applied, so `prisma migrate deploy` will not run it again either.
//
// Reads DATABASE_URL. Through the pg package npm ci installed: a Render Node image has no psql.
// Exits 0 whenever the deploy should go on; a failed drop or rebuild is printed and the next
// deploy tries again. The caller decides what to do with a non-zero exit.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const MIGRATIONS = path.join(__dirname, "..", "packages", "core", "prisma", "migrations");

async function withClient(fn) {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 10_000,
    application_name: "migrate-deploy",
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function list(client) {
  const { rows } = await client.query(
    `SELECT i.relname AS name
       FROM pg_index x
       JOIN pg_class i ON i.oid = x.indexrelid
       JOIN pg_class t ON t.oid = x.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = current_schema() AND NOT x.indisvalid
        AND NOT EXISTS (SELECT 1 FROM pg_stat_progress_create_index p WHERE p.relid = x.indrelid)
      ORDER BY i.relname`,
  );
  return rows.map((r) => r.name);
}

const quoteIdent = (name) => `"${name.replace(/"/g, '""')}"`;

/** The `CREATE INDEX CONCURRENTLY IF NOT EXISTS "name" ...;` statement of a migration file, by name. */
function createStatements() {
  const out = new Map();
  if (!fs.existsSync(MIGRATIONS)) return out;
  for (const dir of fs.readdirSync(MIGRATIONS)) {
    const file = path.join(MIGRATIONS, dir, "migration.sql");
    if (!fs.existsSync(file)) continue;
    const sql = fs.readFileSync(file, "utf8").replace(/^--.*$/gm, "");
    const re = /CREATE\s+INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+"([^"]+)"[^;]*;/gi;
    for (const m of sql.matchAll(re)) out.set(m[1], m[0].replace(/\s+/g, " ").trim());
  }
  return out;
}

async function main() {
  const [cmd, ...names] = process.argv.slice(2);
  if (cmd === "list") {
    const found = await withClient(list);
    for (const name of found) console.log(name);
    return 0;
  }
  if (cmd === "drop") {
    let failed = 0;
    await withClient(async (client) => {
      for (const name of names) {
        try {
          await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${quoteIdent(name)}`);
          console.log(`migrate-deploy: dropped invalid index ${name}`);
        } catch (err) {
          failed += 1;
          console.error(`migrate-deploy: could not drop invalid index ${name}: ${String(err)}`);
        }
      }
    });
    return failed === 0 ? 0 : 1;
  }
  if (cmd === "recreate") {
    const statements = createStatements();
    let failed = 0;
    await withClient(async (client) => {
      for (const name of names) {
        const statement = statements.get(name);
        if (!statement) {
          console.error(
            `migrate-deploy: no migration creates ${name} with CREATE INDEX CONCURRENTLY; rebuild it by hand`,
          );
          failed += 1;
          continue;
        }
        const started = Date.now();
        try {
          await client.query(statement);
          console.log(`migrate-deploy: rebuilt ${name} in ${Math.round((Date.now() - started) / 1000)}s`);
        } catch (err) {
          failed += 1;
          console.error(`migrate-deploy: rebuilding ${name} failed: ${String(err)}`);
        }
      }
    });
    return failed === 0 ? 0 : 1;
  }
  console.error("usage: migrate-invalid-indexes.cjs list | drop NAME... | recreate NAME...");
  return 2;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`migrate-deploy: invalid-index step failed: ${String(err)}`);
    process.exit(1);
  },
);
