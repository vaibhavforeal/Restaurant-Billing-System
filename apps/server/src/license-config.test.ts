import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
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
