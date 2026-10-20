import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.db.test.ts", "apps/*/src/**/*.db.test.ts"],
    globalSetup: ["packages/db/test/global-setup.ts"],
    // Tests share one database and truncate between cases, so files must not run in parallel.
    fileParallelism: false,
  },
});
