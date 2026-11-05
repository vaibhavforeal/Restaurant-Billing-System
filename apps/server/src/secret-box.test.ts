import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSecretKey, seal, unseal } from "./secret-box.js";

describe("secret box", () => {
  const key = randomBytes(32);
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "secret-box-")); dirs.push(dir); return dir; };

  it("round-trips text with the same key", () => {
    const sealed = seal(key, "sk-or-123");
    expect(unseal(key, sealed)).toBe("sk-or-123");
    expect(seal(key, "sk-or-123")).not.toBe(sealed);
    expect(sealed).not.toContain("sk-or-123");
  });

  it("rejects a wrong key or a changed byte", () => {
    const sealed = seal(key, "secret value");
    expect(() => unseal(randomBytes(32), sealed)).toThrow();
    const [v, iv, tag, data] = sealed.split(".");
    const changed = Buffer.from(data!, "base64"); changed[0] = changed[0]! ^ 1;
    expect(() => unseal(key, [v, iv, tag, changed.toString("base64")].join("."))).toThrow();
  });

  it("rejects an unknown format", () => {
    expect(() => unseal(key, "v2.a.b.c")).toThrow("Unsupported credential format");
    expect(() => unseal(key, "junk")).toThrow("Unsupported credential format");
  });

  it("resolveSecretKey uses the shell key, else a dev key file, else nothing in commercial builds", () => {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    const shell = randomBytes(32);
    expect(resolveSecretKey({ dataDir: tempDir(), secretKey: shell.toString("base64"), commercial: true, warn })).toEqual(shell);
    const dir = tempDir();
    const dev = resolveSecretKey({ dataDir: dir, secretKey: undefined, commercial: false, warn });
    expect(dev).toHaveLength(32);
    expect(Buffer.from(readFileSync(join(dir, "dev-secret.key"), "utf8").trim(), "base64")).toEqual(dev);
    expect(resolveSecretKey({ dataDir: dir, secretKey: undefined, commercial: false, warn })).toEqual(dev);
    expect(resolveSecretKey({ dataDir: tempDir(), secretKey: undefined, commercial: true, warn })).toBeUndefined();
    expect(resolveSecretKey({ dataDir: tempDir(), secretKey: randomBytes(16).toString("base64"), commercial: true, warn })).toBeUndefined();
  });
});
