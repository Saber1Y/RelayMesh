import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    // Database integration tests need Postgres; they run via `pnpm test:db`.
    exclude: ["**/node_modules/**", "**/*.db.test.ts"],
  },
});
