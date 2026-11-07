import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = __dirname;
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("domain imports in the browser bundle", () => {
  // The domain root re-exports server-only modules (uuidv7 uses node:crypto), which blank the app in Vite dev.
  it("imports only types from the @masalapos/domain root; values come from subpaths", () => {
    const offenders = sources(SRC).filter((file) => {
      const text = readFileSync(file, "utf8");
      return [...text.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+"@masalapos\/domain"/g)]
        .some(([, typeOnly, names]) => !typeOnly && (names ?? "").split(",").some((n) => n.trim() && !n.trim().startsWith("type ")));
    }).map((file) => file.slice(SRC.length + 1));
    expect(offenders).toEqual([]);
  });
});
