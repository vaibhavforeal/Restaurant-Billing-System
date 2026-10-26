import { readFileSync, mkdirSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const snapshot = resolve(root, "apps/ui/dev-ui-snapshot");
const manifest = JSON.parse(readFileSync(resolve(snapshot, "manifest.json"), "utf8"));
const targets = ["apps/ui/dist", "build/desktop/demo/ui"].map((p) => resolve(root, p));

// Validate every file before changing either generated UI directory.
for (const [file, hash] of Object.entries(manifest.files)) {
  const source = resolve(snapshot, file);
  if (!source.startsWith(snapshot + sep)) throw new Error(`Invalid snapshot path: ${file}`);
  const actual = createHash("sha256").update(readFileSync(source)).digest("hex");
  if (actual !== hash) throw new Error(`Snapshot checksum mismatch: ${file}`);
}
for (const target of targets) {
  for (const file of Object.keys(manifest.files)) {
    const destination = resolve(target, file);
    if (!destination.startsWith(target + sep)) throw new Error(`Invalid target path: ${file}`);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(resolve(snapshot, file), destination);
  }
  console.log(`Restored exact Dev UI: ${target}`);
}
