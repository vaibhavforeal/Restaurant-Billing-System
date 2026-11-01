import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareDemoDirectory, resetDemoDatabase } from "./demo-data.js";
const directories: string[] = [];
const temp = () => { const path = mkdtempSync(join(tmpdir(), "masalapos-demo-test-")); directories.push(path); return path; };
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
describe("isolated demo reset", () => {
  it("archives only the marked demo database and keeps an adjacent restaurant intact", () => {
    const root = temp(), demo = prepareDemoDirectory(join(root, "demo"));
    writeFileSync(join(root, "masalapos.db"), "restaurant");
    writeFileSync(join(demo, "masalapos.db"), "demo changes");
    writeFileSync(join(demo, "masalapos.db-wal"), "demo WAL");
    const archive = resetDemoDatabase(demo);
    expect(readFileSync(join(archive, "masalapos.db"), "utf8")).toBe("demo changes");
    expect(readFileSync(join(root, "masalapos.db"), "utf8")).toBe("restaurant");
    expect(existsSync(join(demo, "masalapos.db"))).toBe(false);
    expect(prepareDemoDirectory(demo)).toBe(demo);
  });
  it("refuses initialization or reset of an unmarked restaurant", () => {
    const root = temp(); writeFileSync(join(root, "masalapos.db"), "restaurant");
    expect(() => prepareDemoDirectory(root)).toThrow("existing restaurant");
    expect(() => resetDemoDatabase(root)).toThrow("isolated demo");
    expect(readFileSync(join(root, "masalapos.db"), "utf8")).toBe("restaurant");
  });
});
