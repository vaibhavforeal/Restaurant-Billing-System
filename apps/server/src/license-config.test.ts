import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { licenseConfig } from "./license-config.js";

const directories: string[] = [];
const publicKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
function directory() {
  const path = mkdtempSync(join(tmpdir(), "forkflow-license-config-"));
  directories.push(path);
  return path;
}
afterEach(() => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("customer build license configuration", () => {
  it("keeps embedded enforcement when the runtime key is cleared or replaced", () => {
    vi.stubGlobal("__FORKFLOW_COMMERCIAL__", true);
    vi.stubGlobal("__FORKFLOW_LICENSE_PUBLIC_KEY__", publicKey);
    vi.stubEnv("FORKFLOW_LICENSE_PUBLIC_KEY", "");
    const path = directory();
    const first = licenseConfig(path)!;
    expect(first.publicKey).toBe(publicKey);
    vi.stubEnv("FORKFLOW_LICENSE_PUBLIC_KEY", "replacement");
    expect(licenseConfig(path)).toEqual(first);
    expect(first.installationId).toMatch(/^[a-f0-9-]{36}$/);
  });

  it("refuses to start a customer build without its embedded key", () => {
    vi.stubGlobal("__FORKFLOW_COMMERCIAL__", true);
    vi.stubGlobal("__FORKFLOW_LICENSE_PUBLIC_KEY__", "");
    vi.stubEnv("FORKFLOW_LICENSE_PUBLIC_KEY", publicKey);
    expect(() => licenseConfig(directory())).toThrow("missing its license verification key");
  });

  it("keeps non-commercial packaged builds independent of ambient licensing", () => {
    vi.stubGlobal("__FORKFLOW_COMMERCIAL__", false);
    vi.stubGlobal("__FORKFLOW_LICENSE_PUBLIC_KEY__", "");
    vi.stubEnv("FORKFLOW_LICENSE_PUBLIC_KEY", publicKey);
    expect(licenseConfig(directory())).toBeUndefined();
  });

  it("allows source development to exercise licensing with an environment key", () => {
    vi.stubGlobal("__FORKFLOW_COMMERCIAL__", undefined);
    vi.stubGlobal("__FORKFLOW_LICENSE_PUBLIC_KEY__", undefined);
    vi.stubEnv("FORKFLOW_LICENSE_PUBLIC_KEY", publicKey);
    expect(licenseConfig(directory())?.publicKey).toBe(publicKey);
  });
});

describe("installation secret", () => {
  const dev = () => {
    vi.stubGlobal("__FORKFLOW_COMMERCIAL__", undefined);
    vi.stubGlobal("__FORKFLOW_LICENSE_PUBLIC_KEY__", undefined);
    vi.stubEnv("FORKFLOW_LICENSE_PUBLIC_KEY", publicKey);
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

  it("keeps a valid secret as it is", () => {
    dev();
    const path = directory(), installationId = randomUUID(), installationSecret = "ab".repeat(32);
    writeFileSync(join(path, "installation.json"), JSON.stringify({ installationId, installationSecret }));
    expect(licenseConfig(path)).toMatchObject({ installationId, installationSecret });
  });
});

describe("licensing service URL", () => {
  const customer = () => {
    vi.stubGlobal("__FORKFLOW_COMMERCIAL__", true);
    vi.stubGlobal("__FORKFLOW_LICENSE_PUBLIC_KEY__", publicKey);
  };

  it("uses the embedded URL in a customer build whatever the environment says", () => {
    customer();
    vi.stubGlobal("__FORKFLOW_LICENSE_SERVICE_URL__", "https://license.example.com/");
    vi.stubEnv("FORKFLOW_LICENSE_SERVICE_URL", "https://attacker.example.net");
    expect(licenseConfig(directory())?.serviceUrl).toBe("https://license.example.com");
    vi.stubEnv("FORKFLOW_LICENSE_SERVICE_URL", "");
    expect(licenseConfig(directory())?.serviceUrl).toBe("https://license.example.com");
  });

  it("leaves a customer build with no embedded URL without one", () => {
    customer();
    vi.stubGlobal("__FORKFLOW_LICENSE_SERVICE_URL__", "");
    vi.stubEnv("FORKFLOW_LICENSE_SERVICE_URL", "https://attacker.example.net");
    expect(licenseConfig(directory())?.serviceUrl).toBeUndefined();
  });

  it("refuses a URL that is not HTTPS", () => {
    customer();
    for (const url of ["http://example.com", "ftp://example.com", "example.com", "https://", "javascript:alert(1)"]) {
      vi.stubGlobal("__FORKFLOW_LICENSE_SERVICE_URL__", url);
      expect(() => licenseConfig(directory()), url).toThrow("Licensing service URL must use HTTPS");
    }
    // Loopback is a development convenience only; a customer build still needs HTTPS.
    vi.stubGlobal("__FORKFLOW_LICENSE_SERVICE_URL__", "http://127.0.0.1:8787");
    expect(() => licenseConfig(directory())).toThrow("Licensing service URL must use HTTPS");
  });

  it("accepts a development environment URL", () => {
    vi.stubGlobal("__FORKFLOW_COMMERCIAL__", undefined);
    vi.stubGlobal("__FORKFLOW_LICENSE_PUBLIC_KEY__", undefined);
    vi.stubGlobal("__FORKFLOW_LICENSE_SERVICE_URL__", undefined);
    vi.stubEnv("FORKFLOW_LICENSE_PUBLIC_KEY", publicKey);
    for (const [url, expected] of [["http://127.0.0.1:8787", "http://127.0.0.1:8787"], ["http://localhost:8787/", "http://localhost:8787"], ["https://license.example.com", "https://license.example.com"]] as const) {
      vi.stubEnv("FORKFLOW_LICENSE_SERVICE_URL", url);
      expect(licenseConfig(directory())?.serviceUrl, url).toBe(expected);
    }
    vi.stubEnv("FORKFLOW_LICENSE_SERVICE_URL", "http://example.com");
    expect(() => licenseConfig(directory())).toThrow("Licensing service URL must use HTTPS");
    vi.stubEnv("FORKFLOW_LICENSE_SERVICE_URL", "");
    expect(licenseConfig(directory())?.serviceUrl).toBeUndefined();
  });
});
