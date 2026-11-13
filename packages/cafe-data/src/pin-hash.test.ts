import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashPin, isValidPin, verifyPin } from "./pin-hash.js";

describe("pin-hash", () => {
  it("verifies the PIN it hashed and refuses another", async () => {
    const stored = await hashPin("1234", { iterations: 1000 });
    expect(stored.startsWith("pbkdf2-sha256$1000$")).toBe(true);
    // Below the default count, so a rehash is asked for; the point here is ok true/false.
    expect((await verifyPin("1234", stored)).ok).toBe(true);
    expect(await verifyPin("1235", stored)).toEqual({ ok: false, rehash: false });
  });
  it("does not ask for a rehash at the current count", async () => {
    const stored = await hashPin("1234");
    expect(await verifyPin("1234", stored)).toEqual({ ok: true, rehash: false });
  });
  it("salts each hash differently", async () => {
    expect(await hashPin("1234", { iterations: 1000 })).not.toBe(await hashPin("1234", { iterations: 1000 }));
  });
  it("accepts a Phase 1 hash once and asks for a rehash", async () => {
    const stored = createHash("sha256").update("dev1:1234").digest("hex");
    expect(await verifyPin("1234", stored, { deviceId: "dev1" })).toEqual({ ok: true, rehash: true });
    expect(await verifyPin("1235", stored, { deviceId: "dev1" })).toEqual({ ok: false, rehash: false });
    expect((await verifyPin("1234", stored)).ok).toBe(false);
  });
  it("asks for a rehash when the stored count is below the current one", async () => {
    const stored = await hashPin("1234", { iterations: 1000 });
    expect(await verifyPin("1234", stored)).toEqual({ ok: true, rehash: true });
  });
  it("rejects malformed stored values without throwing", async () => {
    for (const bad of ["pbkdf2-sha256$x$y", "pbkdf2-sha256$1000$!!$!!", "pbkdf2-sha256$0$AAAA$AAAA", ""]) {
      expect((await verifyPin("1234", bad)).ok).toBe(false);
    }
  });
  it.each([["123", false], ["1234", true], ["123456", true], ["1234567", false], ["12a4", false]])("isValidPin(%s) is %s", (pin, ok) => {
    expect(isValidPin(pin)).toBe(ok);
  });
});
