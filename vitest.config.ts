import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { workspaceExports } from "./tools/workspace-exports.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // Subpath imports resolve through each package's exports map, so folder subpaths work too.
      ...Object.entries({ ...workspaceExports(root, "domain"), ...workspaceExports(root, "core") }).filter(([spec]) => spec.split("/").length > 2).map(([find, replacement]) => ({ find, replacement })),
      { find: /^@board\//, replacement: fileURLToPath(new URL("./apps/ui/src/dynamic-dashboard/boardui/", import.meta.url)) },
      { find: "@masalapos/domain", replacement: pkg("domain") },
      { find: "@masalapos/core", replacement: pkg("core") },
      { find: "@masalapos/print", replacement: pkg("print") },
      { find: "@masalapos/cafe-data", replacement: pkg("cafe-data") },
      { find: "@masalapos/license-issuer", replacement: pkg("license-issuer") },
    ],
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "tools/*.test.ts"],
    testTimeout: 30_000,
  },
});
