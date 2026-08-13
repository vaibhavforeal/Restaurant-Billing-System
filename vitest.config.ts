import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@forkflow/sync": pkg("sync"),
      "@forkflow/db": pkg("db"),
      "@forkflow/core": pkg("core"),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    // Sync tests spin up in-process Postgres (PGlite) + SQLite; give them room.
    testTimeout: 30_000,
  },
});
