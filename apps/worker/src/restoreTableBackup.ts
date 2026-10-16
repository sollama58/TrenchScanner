import "./bootstrap-env.js"; // must run before any @trenchscanner/core import - see file comment
import { readFile } from "node:fs/promises";
import { decodeTableBackup, prisma, restoreTableBackup } from "@trenchscanner/core";

/**
 * Puts a downloaded table backup back into the database DATABASE_URL points at, additively (rows
 * that already exist are left alone; see backup/tableBackup.ts). README, "Restore".
 *
 *   npm run backup:restore-tables -w @trenchscanner/worker -- trenchscanner-tables-....json.gz
 *   npm run backup:restore-tables -w @trenchscanner/worker -- <file> --dry-run   (counts only)
 */
async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("usage: backup:restore-tables <backup file> [--dry-run]");
    return 2;
  }
  const payload = decodeTableBackup(await readFile(file));
  console.log(`backup of ${payload.createdAt} (${payload.kind}${payload.note ? `, ${payload.note}` : ""})`);
  for (const t of payload.tables) console.log(`  ${t.name}: ${t.rows.length} rows`);
  if (dryRun) return 0;
  const result = await restoreTableBackup(payload);
  for (const t of result.tables) {
    console.log(
      `  ${t.name}: ${t.inserted} put back, ${t.rows - t.inserted - t.skipped} already there, ${t.skipped} skipped (parent gone)`,
    );
  }
  return 0;
}

main()
  .then((code) => prisma.$disconnect().then(() => process.exit(code)))
  .catch(async (err) => {
    console.error(String(err));
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  });
