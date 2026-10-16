import "./bootstrap-env.js"; // must run before any @trenchscanner/core import - see file comment
import { readFile } from "node:fs/promises";
import { ACCESS_TABLES, decodeTableBackup, prisma, restoreTableBackup } from "@trenchscanner/core";

/**
 * Puts a downloaded table backup back into the database DATABASE_URL points at, additively (rows
 * that already exist are left alone; see backup/tableBackup.ts). README, "Restore".
 *
 *   npm run backup:restore-tables -w @trenchscanner/worker -- <file> --tables UserFilter,CuratedAlert
 *   npm run backup:restore-tables -w @trenchscanner/worker -- <file> --tables ... --dry-run
 *
 * --tables is required: the restore is additive, so every row deleted since the backup comes
 * back, including deletions that were decisions (a revoked grant, a removed whitelist entry, an
 * account deleted for good). Name only the tables actually lost; --tables all restores every one.
 * --dry-run runs the restore and rolls it back, so its counts are what would come back.
 */
async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const tablesAt = args.indexOf("--tables");
  const tablesArg = tablesAt >= 0 ? args[tablesAt + 1] : undefined;
  const file = args.find((a, i) => !a.startsWith("--") && i !== tablesAt + 1);
  if (!file || !tablesArg) {
    console.error("usage: backup:restore-tables <backup file> --tables <A,B,...|all> [--dry-run]");
    if (file) {
      const payload = decodeTableBackup(await readFile(file));
      console.error(`tables in this backup: ${payload.tables.map((t) => t.name).join(", ")}`);
    }
    return 2;
  }
  const payload = decodeTableBackup(await readFile(file));
  const only =
    tablesArg === "all"
      ? undefined
      : tablesArg
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
  const unknown = (only ?? []).filter((t) => !payload.tables.some((p) => p.name === t));
  if (unknown.length > 0) {
    console.error(`not in this backup: ${unknown.join(", ")}`);
    return 2;
  }
  console.log(`backup of ${payload.createdAt} (${payload.kind}${payload.note ? `, ${payload.note}` : ""})`);
  const result = await restoreTableBackup(payload, { only, dryRun });
  if (dryRun) console.log("dry run (rolled back; nothing changed):");
  for (const t of result.tables) {
    console.log(
      `  ${t.name}: ${t.inserted} ${dryRun ? "would be put back" : "put back"}, ${t.rows - t.inserted - t.skipped} already there, ${t.skipped} skipped (parent gone)`,
    );
  }
  const revived = result.tables.filter((t) => ACCESS_TABLES.includes(t.name) && t.inserted > 0);
  if (revived.length > 0) {
    console.warn(
      `WARNING: ${revived.map((t) => `${t.name} (${t.inserted})`).join(", ")} ${dryRun ? "would get" : "got"} rows back. ` +
        "Deleted access rows are often revocations or deletions on purpose; check them.",
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
