import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { constantTimeEqual, isWellFormedSecret, SECRET_HEADER, sha256Hex, verifyInstallationSecret } from "./secret.js";
import { createInstallation, getInstallation } from "./store.js";
import { memoryD1 } from "./testing/d1.js";
import { TEST_SECRET } from "./testing/secret.js";

describe("installation secret helpers", () => {
  it("the header name is lowercase", () => { expect(SECRET_HEADER).toBe("x-forkflow-installation-secret"); });

  it("accepts exactly 64 lowercase hex characters", () => {
    expect(isWellFormedSecret("0123456789abcdef".repeat(4))).toBe(true);
    for (const bad of [null, "", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), `${"a".repeat(63)}\n`, ` ${"a".repeat(63)}`]) expect(isWellFormedSecret(bad)).toBe(false);
  });

  it("sha256Hex is the lowercase hex digest", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("constantTimeEqual compares whole strings", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("", "")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "xbc")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("abcd", "abc")).toBe(false);
    expect(constantTimeEqual("", "a")).toBe(false);
  });

  it("verifyInstallationSecret never claims a NULL-hash row for a malformed, empty or missing secret", async () => {
    const db = memoryD1();
    const installationId = randomUUID();
    await createInstallation(db, { installationId, licenseId: randomUUID(), organizationId: randomUUID(), outletId: randomUUID(), revisionFloor: 0, createdAt: 0, secretHash: null });
    for (const bad of [null, "", "nope", "A".repeat(64), "a".repeat(63)]) {
      const row = (await getInstallation(db, installationId))!;
      expect(await verifyInstallationSecret(db, row, bad)).toBeNull();
      expect((await getInstallation(db, installationId))!.secretHash).toBeNull();
    }
    const row = (await getInstallation(db, installationId))!;
    expect((await verifyInstallationSecret(db, row, TEST_SECRET))?.secretHash).toBe(await sha256Hex(TEST_SECRET));
  });
});
