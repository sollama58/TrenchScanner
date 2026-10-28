/**
 * Vitest globalSetup shared by the workspaces whose tests use Postgres (core, api, worker).
 *
 * Their database suites guard themselves with `describe.skipIf(!dbAvailable)`, so a run with no
 * reachable database passes with those suites skipped: a local "green" from a machine without
 * Postgres covered far less than it said (full audit 2026-10-27, CH-11). With REQUIRE_TEST_DB=1
 * (CI sets it, and so should anyone running the shipping-rule local checks) the run fails up front
 * instead. Same idea as TokenSage's TS_REQUIRE_DB.
 */
export default async function requireTestDatabase(): Promise<void> {
  if (process.env.REQUIRE_TEST_DB !== "1") return;
  // The workspaces' bootstrap-env loads the root .env inside the test files, which run after this,
  // so read it here too; it never overrides a DATABASE_URL already set.
  const { config } = await import("dotenv");
  config({ path: new URL("./.env", import.meta.url).pathname, quiet: true });
  const url = process.env.DATABASE_URL;
  if (!url)
    throw new Error("REQUIRE_TEST_DB=1 but DATABASE_URL is not set: the database tests would all skip.");
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    const reason = (err instanceof Error ? err.message : String(err))
      .trim()
      .split("\n")
      .filter(Boolean)
      .pop();
    throw new Error(
      `REQUIRE_TEST_DB=1 but the test database is unreachable, so the database tests would all skip: ${reason}`,
      {
        cause: err,
      },
    );
  } finally {
    await prisma.$disconnect();
  }
}
