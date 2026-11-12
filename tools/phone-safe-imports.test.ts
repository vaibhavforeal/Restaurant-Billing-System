import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { workspaceExports } from "./workspace-exports.mjs";

const root = resolve(__dirname, "..");
/** Everything the phone bundle starts from. Later tasks append to this list. */
export const PHONE_ENTRIES: string[] = [
  "@masalapos/domain/id", "@masalapos/domain/billing", "@masalapos/domain/gst", "@masalapos/domain/round-off",
  "@masalapos/domain/invoice-numbers", "@masalapos/domain/receipt-styles", "@masalapos/domain/bill-print",
  "@masalapos/domain/printer-schemas", "@masalapos/domain/settings-schemas",
  "packages/print/src/index.ts",
];
const DENIED = /^(node:.*|better-sqlite3|fs|path|crypto|os|net|http|https|child_process|worker_threads)$/;
const FROM = /^[ \t]*(?:import|export)\s+(type\s+)?[^;'"]*?from\s+["']([^"']+)["']/gm;
const BARE = /^[ \t]*import\s+["']([^"']+)["']/gm;

function workspaceFile(spec: string): string | undefined {
  const name = spec.split("/")[1]!;
  return existsSync(join(root, "packages", name)) ? workspaceExports(root, name)[spec] : undefined;
}
function relativeFile(from: string, spec: string): string | undefined {
  const base = join(dirname(from), spec.replace(/\.js$/, ""));
  return [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")].find((p) => existsSync(p));
}
/** Walks value imports from the entries and returns "file -> import" for every denied or unresolvable one. */
export function phoneOffenders(entries: string[]): string[] {
  const offenders: string[] = [];
  const seen = new Set<string>();
  const queue = entries.map((e) => (e.startsWith("@masalapos/") ? workspaceFile(e) ?? e : resolve(root, e)));
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!existsSync(file)) { offenders.push(`${file} -> not found`); continue; }
    const text = readFileSync(file, "utf8");
    const specs = [...text.matchAll(FROM)].filter((m) => !m[1]).map((m) => m[2]!).concat([...text.matchAll(BARE)].map((m) => m[1]!));
    for (const spec of specs) {
      const where = `${file.slice(root.length + 1).replaceAll("\\", "/")} -> ${spec}`;
      if (DENIED.test(spec) || /(^|\/)db\.js$/.test(spec)) offenders.push(where);
      else if (spec.startsWith(".")) { const next = relativeFile(file, spec); next ? queue.push(next) : offenders.push(`${where} (unresolved)`); }
      else if (spec.startsWith("@masalapos/")) { const next = workspaceFile(spec); next ? queue.push(next) : offenders.push(`${where} (not exported)`); }
    }
  }
  return offenders.sort();
}

describe("code the phone can reach", () => {
  it("imports no Node built-ins, no better-sqlite3 and no db.ts", () => {
    expect(phoneOffenders(PHONE_ENTRIES)).toEqual([]);
  });
});
