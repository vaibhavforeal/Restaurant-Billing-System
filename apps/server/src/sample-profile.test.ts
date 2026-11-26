
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { archiveSampleDirectory, checkSampleDirectory, populateSampleDirectory, SAMPLE_PROFILE } from "./sample-profile.js";

const scratch: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "masalapos-profile-test-"));
  scratch.push(root);
  const data = join(root, SAMPLE_PROFILE, "data");
  mkdirSync(data, { recursive: true });
  return { root, data, target: join(data, "masalapos.db") };
}
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Dev sample profile", () => {
  it("rejects ordinary profiles and refuses to mark an existing database", async () => {
    const { data, target, root } = fixture();
    writeFileSync(target, "restaurant data");
    expect(() => checkSampleDirectory(root, true)).toThrow("its own MasalaPOS Dev profile");
    expect(() => checkSampleDirectory(data, true)).toThrow("existing database");
    await expect(populateSampleDirectory(data, async () => {})).rejects.toThrow("marker");
    expect(readFileSync(target, "utf8")).toBe("restaurant data");
  });

  it("publishes only successful seeds, preserves edits, and archives the entire profile on reset", async () => {
    const { data, target } = fixture();
    checkSampleDirectory(data, true);
    await expect(populateSampleDirectory(data, async path => {
      writeFileSync(path, "incomplete");
      throw new Error("interrupted");
    })).rejects.toThrow("interrupted");
    expect(existsSync(target)).toBe(false);

    await populateSampleDirectory(data, async path => { writeFileSync(path, "sample"); });
    writeFileSync(target, "sample edits");
    await populateSampleDirectory(data, async () => { throw new Error("should not reseed"); });
    mkdirSync(join(data, "backups"));
    writeFileSync(join(data, "backups", "backup.db"), "backup");
    const generation = readFileSync(join(data, "recovery-generation.json"), "utf8");
    const archive = archiveSampleDirectory(data);
    expect(readFileSync(join(archive, "masalapos.db"), "utf8")).toBe("sample edits");
    expect(readFileSync(join(archive, "backups", "backup.db"), "utf8")).toBe("backup");
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(join(data, "recovery-generation.json"), "utf8")).not.toBe(generation);
    await populateSampleDirectory(data, async path => { writeFileSync(path, "fresh sample"); });
    expect(readFileSync(target, "utf8")).toBe("fresh sample");
  });
});
