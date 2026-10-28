import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // REQUIRE_TEST_DB=1 turns "no database, so the database suites skipped" into a failure.
    globalSetup: ["../../vitest.requireDb.ts"],
  },
});
