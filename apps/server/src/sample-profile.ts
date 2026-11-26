
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

export const SAMPLE_PROFILE = "masalapos-dev-sample";
const markerFile = "sample-environment.txt";
const marker = "MasalaPOS Dev Sample Data v1\n";

export function checkSampleDirectory(path: string, createMarker = false): void {
  const dir = resolve(path);
  if (basename(dir) !== "data" || basename(dirname(dir)) !== SAMPLE_PROFILE
      || realpathSync(dir).toLowerCase() !== dir.toLowerCase()) {
    throw new Error("Sample data requires its own MasalaPOS Dev profile.");
  }
  const file = join(dir, markerFile);
  if (!existsSync(file) && createMarker) {
    if (["masalapos.db", "masalapos.db-wal", "masalapos.db-shm"].some(name => existsSync(join(dir, name)))) {
      throw new Error("Refusing to mark an existing database as sample data.");
    }
    writeFileSync(file, marker, { flag: "wx" });
    writeGeneration(dir);
  }
  if (!existsSync(file) || lstatSync(file).isSymbolicLink() || readFileSync(file, "utf8") !== marker) {
    throw new Error("Missing MasalaPOS Dev sample profile marker.");
  }
}

function writeGeneration(dir: string) {
  writeFileSync(join(dir, "recovery-generation.json"), JSON.stringify({ generation: randomUUID() }));
}

/** Call after the sample server and its SQLite handles have stopped. */
export function archiveSampleDirectory(path: string): string {
  const dir = resolve(path);
  checkSampleDirectory(dir);
  const parent = dirname(dir);
  const next = mkdtempSync(join(parent, "reset-next-"));
  const archive = join(parent, `archive-${Date.now()}-${randomUUID()}`);
  try {
    writeFileSync(join(next, markerFile), marker);
    writeGeneration(next);
    renameSync(dir, archive);
    try { renameSync(next, dir); }
    catch (error) { renameSync(archive, dir); throw error; }
    return archive;
  } finally {
    if (existsSync(next)) {
      for (const name of [markerFile, "recovery-generation.json"]) {
        const file = join(next, name);
        if (existsSync(file)) unlinkSync(file);
      }
      rmdirSync(next);
    }
  }
}

/** Caller holds the data directory lock. Only publish a complete, closed SQLite database. */
export async function populateSampleDirectory(dir: string, seed: (path: string) => Promise<void>) {
  checkSampleDirectory(dir);
  const target = join(dir, "masalapos.db");
  if (existsSync(target)) {
    if (lstatSync(target).isSymbolicLink()) throw new Error("The sample database points outside its profile.");
    return;
  }
  if (["masalapos.db-wal", "masalapos.db-shm"].some(name => existsSync(join(dir, name)))) {
    throw new Error("Unexpected SQLite recovery files in sample profile.");
  }
  const stage = mkdtempSync(join(dir, "seed-"));
  const temporary = join(stage, "masalapos.db");
  try {
    await seed(temporary);
    renameSync(temporary, target);
  } finally {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      const file = temporary + suffix;
      if (existsSync(file)) unlinkSync(file);
    }
    rmdirSync(stage);
  }
}
