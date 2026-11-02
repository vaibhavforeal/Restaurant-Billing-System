import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Where each import of a workspace package points, read from the package's own `exports` map.
 * Returns specifier to absolute source file, e.g. "@masalapos/domain/dashboard" to .../src/dashboard/index.ts.
 */
export function workspaceExports(root, name) {
  const dir = join(root, "packages", name);
  const { exports } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  return Object.fromEntries(Object.entries(exports).map(([key, file]) => [`@masalapos/${name}${key.slice(1)}`, join(dir, file)]));
}

/** The source file for one import, or an error naming the missing export. */
export function resolveWorkspace(root, specifier) {
  const name = specifier.split("/")[1];
  const file = workspaceExports(root, name)[specifier];
  if (!file) throw new Error(`${specifier} is not listed in packages/${name}/package.json exports`);
  return file;
}
