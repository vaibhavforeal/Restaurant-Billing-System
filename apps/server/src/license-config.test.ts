import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { adoptStagedActivation, licenseConfig, readTrustedStagedFile } from "./license-config.js";

const directories: string[] = [];
const publicKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
function directory() {
  const path = mkdtempSync(join(tmpdir(), "masalapos-license-config-"));
  directories.push(path);
  return path;
}
afterEach(() => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("customer build license configuration", () => {
  it("keeps embedded enforcement when the runtime key is cleared or replaced", () => {
    vi.stubGlobal("__MASALAPOS_COMMERCIAL__", true);
    vi.stubGlobal("__MASALAPOS_LICENSE_PUBLIC_KEY__", publicKey);
    vi.stubEnv("MASALAPOS_LICENSE_PUBLIC_KEY", "");
    const path = directory();
    const first = licenseConfig(path)!;
    expect(first.publicKey).toBe(publicKey);
    vi.stubEnv("MASALAPOS_LICENSE_PUBLIC_KEY", "replacement");
    expect(licenseConfig(path)).toEqual(first);
    expect(first.installationId).toMatch(/^[a-f0-9-]{36}$/);
  });

  it("refuses to start a customer build without its embedded key", () => {
    vi.stubGlobal("__MASALAPOS_COMMERCIAL__", true);
    vi.stubGlobal("__MASALAPOS_LICENSE_PUBLIC_KEY__", "");
    vi.stubEnv("MASALAPOS_LICENSE_PUBLIC_KEY", publicKey);
    expect(() => licenseConfig(directory())).toThrow("missing its license verification key");
  });

  it("keeps non-commercial packaged builds independent of ambient licensing", () => {
    vi.stubGlobal("__MASALAPOS_COMMERCIAL__", false);
    vi.stubGlobal("__MASALAPOS_LICENSE_PUBLIC_KEY__", "");
    vi.stubEnv("MASALAPOS_LICENSE_PUBLIC_KEY", publicKey);
    expect(licenseConfig(directory())).toBeUndefined();
  });

  it("allows source development to exercise licensing with an environment key", () => {
    vi.stubGlobal("__MASALAPOS_COMMERCIAL__", undefined);
    vi.stubGlobal("__MASALAPOS_LICENSE_PUBLIC_KEY__", undefined);
    vi.stubEnv("MASALAPOS_LICENSE_PUBLIC_KEY", publicKey);
    expect(licenseConfig(directory())?.publicKey).toBe(publicKey);
  });
});

describe("installation secret", () => {
  const dev = () => {
    vi.stubGlobal("__MASALAPOS_COMMERCIAL__", undefined);
    vi.stubGlobal("__MASALAPOS_LICENSE_PUBLIC_KEY__", undefined);
    vi.stubEnv("MASALAPOS_LICENSE_PUBLIC_KEY", publicKey);
  };

  it("gives a new installation an id and a 64 hex character secret", () => {
    dev();
    const path = directory();
    const config = licenseConfig(path)!;
    expect(config.installationSecret).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(readFileSync(join(path, "installation.json"), "utf8"))).toEqual({ installationId: config.installationId, installationSecret: config.installationSecret });
    expect(licenseConfig(directory())!.installationSecret).not.toBe(config.installationSecret);
  });

  it("adds a secret to an older file that only has the id, keeping the id and the secret across starts", () => {
    dev();
    const path = directory(), installationId = randomUUID();
    writeFileSync(join(path, "installation.json"), JSON.stringify({ installationId }));
    const first = licenseConfig(path)!;
    expect(first.installationId).toBe(installationId);
    expect(first.installationSecret).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(readFileSync(join(path, "installation.json"), "utf8"))).toEqual({ installationId, installationSecret: first.installationSecret });
    expect(licenseConfig(path)).toEqual(first);
  });

  it("replaces a malformed secret and keeps the id", () => {
    dev();
    for (const bad of ["short", "A".repeat(64), "g".repeat(64), 42, null]) {
      const path = directory(), installationId = randomUUID();
      writeFileSync(join(path, "installation.json"), JSON.stringify({ installationId, installationSecret: bad }));
      const config = licenseConfig(path)!;
      expect(config.installationId).toBe(installationId);
      expect(config.installationSecret).toMatch(/^[a-f0-9]{64}$/);
      expect(licenseConfig(path)!.installationSecret).toBe(config.installationSecret);
    }
  });

  it("does not rewrite a file that has no installation id", () => {
    dev();
    for (const content of ["{}", JSON.stringify({ installationId: 7, note: "x" })]) {
      const path = directory();
      writeFileSync(join(path, "installation.json"), content);
      expect(typeof licenseConfig(path)!.installationId).not.toBe("string");
      expect(readFileSync(join(path, "installation.json"), "utf8")).toBe(content);
    }
  });

  it("keeps a valid secret as it is", () => {
    dev();
    const path = directory(), installationId = randomUUID(), installationSecret = "ab".repeat(32);
    writeFileSync(join(path, "installation.json"), JSON.stringify({ installationId, installationSecret }));
    expect(licenseConfig(path)).toMatchObject({ installationId, installationSecret });
  });
});

describe("activation made by the installer", () => {
  const dev = () => {
    vi.stubGlobal("__MASALAPOS_COMMERCIAL__", undefined);
    vi.stubGlobal("__MASALAPOS_LICENSE_PUBLIC_KEY__", undefined);
    vi.stubEnv("MASALAPOS_LICENSE_PUBLIC_KEY", publicKey);
  };
  const stage = (content: object | string) => {
    const path = join(directory(), "activation.json");
    writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
    return path;
  };
  // These files are made by the test, not by setup, so the ownership check is stubbed; its own tests are below.
  const trusted = (path: string) => readFileSync(path, "utf8");
  const staged = (overrides: object = {}) => ({ format: "masalapos-installer-activation", version: 1, installationId: randomUUID(),
    installationSecret: "cd".repeat(32), license: "LICENSE-ENVELOPE", customerCode: "FC-7K3M-9QX", orderCode: "FO-2D8H-4MA", ...overrides });

  it("takes setup's identity on a first start", () => {
    dev();
    const data = directory(), file = staged(), stagedPath = stage(file);
    const config = licenseConfig(data, stagedPath, trusted)!;
    expect(config).toMatchObject({ installationId: file.installationId, installationSecret: file.installationSecret });
    expect(JSON.parse(readFileSync(join(data, "installation.json"), "utf8"))).toEqual({ installationId: file.installationId, installationSecret: file.installationSecret });
  });

  it("never replaces an identity the counter already has", () => {
    dev();
    const data = directory(), installationId = randomUUID(), installationSecret = "ab".repeat(32);
    writeFileSync(join(data, "installation.json"), JSON.stringify({ installationId, installationSecret }));
    expect(licenseConfig(data, stage(staged()), trusted)).toMatchObject({ installationId, installationSecret });
  });

  it("ignores a file that is not setup's", () => {
    dev();
    for (const bad of ["not json", staged({ format: "other" }), staged({ installationSecret: "short" }), staged({ installationId: "x" })]) {
      const file = stage(bad);
      expect(licenseConfig(directory(), file, trusted)!.installationSecret).not.toBe("cd".repeat(32));
    }
  });

  it("installs setup's licence once and removes the file", () => {
    const file = staged(), path = stage(file), activate = vi.fn(), log = vi.fn();
    expect(adoptStagedActivation({ activate }, file.installationId, log, path, trusted)).toBe("installed");
    expect(activate).toHaveBeenCalledWith("LICENSE-ENVELOPE", "Setup");
    expect(existsSync(path)).toBe(false);
    expect(adoptStagedActivation({ activate }, file.installationId, log, path, trusted)).toBe("none");
    expect(activate).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });

  it("ignores a file that setup did not lock down, so another Windows user can't plant an identity", () => {
    dev();
    const file = staged(), path = stage(file), activate = vi.fn();
    expect(licenseConfig(directory(), path, () => null)!.installationId).not.toBe(file.installationId);
    expect(adoptStagedActivation({ activate }, file.installationId, vi.fn(), path, () => null)).toBe("none");
    expect(activate).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === "win32")("trusts a staged file only when Administrators or SYSTEM own it and nobody else can write to it", () => {
    const path = stage(staged());
    // Made by this test run: owned by its user (or, elevated, by Administrators); either way everyone may now write to it.
    execFileSync("icacls.exe", [path, "/grant", "*S-1-1-0:(W)"], { stdio: "pipe" });
    expect(readTrustedStagedFile(path)).toBeNull();
    expect(readTrustedStagedFile(join(directory(), "missing.json"))).toBeNull();
  });

  it("leaves a file made for another installation alone", () => {
    const path = stage(staged()), activate = vi.fn();
    expect(adoptStagedActivation({ activate }, randomUUID(), vi.fn(), path, trusted)).toBe("none");
    expect(activate).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(true);
  });

  it("logs a licence the counter refuses and still removes the file", () => {
    const file = staged(), path = stage(file), log = vi.fn();
    const activate = vi.fn(() => { throw new Error("License is invalid or belongs to another installation"); });
    expect(adoptStagedActivation({ activate }, file.installationId, log, path, trusted)).toBe("failed");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("belongs to another installation"));
    expect(existsSync(path)).toBe(false);
  });

  it("removes a file without a licence (the hourly check fetches it)", () => {
    const file = staged({ license: null }), path = stage(file), activate = vi.fn();
    expect(adoptStagedActivation({ activate }, file.installationId, vi.fn(), path, trusted)).toBe("none");
    expect(activate).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
  });
});

describe("licensing service URL", () => {
  const customer = () => {
    vi.stubGlobal("__MASALAPOS_COMMERCIAL__", true);
    vi.stubGlobal("__MASALAPOS_LICENSE_PUBLIC_KEY__", publicKey);
  };

  it("uses the embedded URL in a customer build whatever the environment says", () => {
    customer();
    vi.stubGlobal("__MASALAPOS_LICENSE_SERVICE_URL__", "https://license.example.com/");
    vi.stubEnv("MASALAPOS_LICENSE_SERVICE_URL", "https://attacker.example.net");
    expect(licenseConfig(directory())?.serviceUrl).toBe("https://license.example.com");
    vi.stubEnv("MASALAPOS_LICENSE_SERVICE_URL", "");
    expect(licenseConfig(directory())?.serviceUrl).toBe("https://license.example.com");
  });

  it("leaves a customer build with no embedded URL without one", () => {
    customer();
    vi.stubGlobal("__MASALAPOS_LICENSE_SERVICE_URL__", "");
    vi.stubEnv("MASALAPOS_LICENSE_SERVICE_URL", "https://attacker.example.net");
    expect(licenseConfig(directory())?.serviceUrl).toBeUndefined();
  });

  it("refuses a URL that is not HTTPS", () => {
    customer();
    for (const url of ["http://example.com", "ftp://example.com", "example.com", "https://", "javascript:alert(1)"]) {
      vi.stubGlobal("__MASALAPOS_LICENSE_SERVICE_URL__", url);
      expect(() => licenseConfig(directory()), url).toThrow("Licensing service URL must use HTTPS");
    }
    // Loopback is a development convenience only; a customer build still needs HTTPS.
    vi.stubGlobal("__MASALAPOS_LICENSE_SERVICE_URL__", "http://127.0.0.1:8787");
    expect(() => licenseConfig(directory())).toThrow("Licensing service URL must use HTTPS");
  });

  it("accepts a development environment URL", () => {
    vi.stubGlobal("__MASALAPOS_COMMERCIAL__", undefined);
    vi.stubGlobal("__MASALAPOS_LICENSE_PUBLIC_KEY__", undefined);
    vi.stubGlobal("__MASALAPOS_LICENSE_SERVICE_URL__", undefined);
    vi.stubEnv("MASALAPOS_LICENSE_PUBLIC_KEY", publicKey);
    for (const [url, expected] of [["http://127.0.0.1:8787", "http://127.0.0.1:8787"], ["http://localhost:8787/", "http://localhost:8787"], ["https://license.example.com", "https://license.example.com"]] as const) {
      vi.stubEnv("MASALAPOS_LICENSE_SERVICE_URL", url);
      expect(licenseConfig(directory())?.serviceUrl, url).toBe(expected);
    }
    vi.stubEnv("MASALAPOS_LICENSE_SERVICE_URL", "http://example.com");
    expect(() => licenseConfig(directory())).toThrow("Licensing service URL must use HTTPS");
    vi.stubEnv("MASALAPOS_LICENSE_SERVICE_URL", "");
    expect(licenseConfig(directory())?.serviceUrl).toBeUndefined();
  });
});
