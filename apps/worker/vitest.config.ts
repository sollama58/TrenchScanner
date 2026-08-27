import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // These are integration tests sharing one real Postgres, and some of them mutate global
    // state (the CuratorModel registry decides which curator EVERY emission test runs under).
    // Parallel files racing over that is a flake generator, not a speedup - the whole suite is
    // sub-second per file either way.
    fileParallelism: false,
  },
});
