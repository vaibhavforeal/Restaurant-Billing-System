import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, realpathSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { randomUUID } from "node:crypto";

const marker = "ForkFlow isolated demo v1\n";
export function prepareDemoDirectory(directory: string) {
  const root = resolve(directory);
  mkdirSync(root, { recursive: true });
  const file = join(root, "demo-environment.txt");
  if (!existsSync(file)) {
    if (existsSync(join(root, "forkflow.db"))) throw new Error("Refusing to use an existing restaurant database as demo data.");
    writeFileSync(file, marker, { flag: "wx" });
  }
  if (readFileSync(file, "utf8") !== marker) throw new Error("This folder is not a ForkFlow demo environment.");
  return root;
}

/** Call only after the demo server has released its database. Keep an archive. */
export function resetDemoDatabase(directory: string) {
  const root = resolve(directory);
  if (!existsSync(join(root, "demo-environment.txt")) || readFileSync(join(root, "demo-environment.txt"), "utf8") !== marker) throw new Error("Reset is allowed only in the isolated demo folder.");
  const actualRoot = realpathSync(root);
  const files = ["forkflow.db", "forkflow.db-wal", "forkflow.db-shm"].map(name => join(root, name)).filter(existsSync);
  for (const file of files) {
    const rel = relative(actualRoot, realpathSync(file));
    if (rel.startsWith("..") || rel.includes("/") || rel.includes("\\")) throw new Error("Demo database points outside its folder.");
  }
  const archive = join(root, `reset-${Date.now()}-${randomUUID()}`);
  mkdirSync(archive);
  for (const file of files) renameSync(file, join(archive, relative(root, file)));
  writeFileSync(join(root, "recovery-generation.json"), JSON.stringify({ generation: randomUUID() }));
  return archive;
}
