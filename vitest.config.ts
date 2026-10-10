import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // Subpath exports (e.g. "@forkflow/domain/gst") resolve to their own source file, not under the index.
      { find: /^@forkflow\/domain\/(.+)$/, replacement: fileURLToPath(new URL("./packages/domain/src/$1.ts", import.meta.url)) },
      { find: "@forkflow/domain", replacement: pkg("domain") },
      { find: "@forkflow/core", replacement: pkg("core") },
      { find: "@forkflow/license-issuer", replacement: pkg("license-issuer") },
    ],
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "tools/*.test.ts"],
    testTimeout: 30_000,
  },
});
