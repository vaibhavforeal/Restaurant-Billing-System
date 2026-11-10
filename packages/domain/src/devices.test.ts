import { describe, expect, it } from "vitest";
import { JoinCodeCreate, normalizeJoinCode } from "./devices.js";

describe("device join codes", () => {
  it("normalises a typed join code", () => {
    expect(normalizeJoinCode("k7m 2qp")).toBe("K7M2QP");
    expect(normalizeJoinCode(" K7M-2QP ")).toBe("K7M2QP");
    for (const bad of ["K7M2Q", "K7M2QPX", "K7M2Q0", "K7M2QO", "K7M2QI", "K7M2QL", "K7M2Q1", "", null, 123456]) expect(normalizeJoinCode(bad)).toBeNull();
  });
  it("accepts a new device or a replacement, not both", () => {
    expect(JoinCodeCreate.parse({ kind: "kitchen", name: "  Pass  " })).toEqual({ kind: "kitchen", name: "Pass" });
    expect(JoinCodeCreate.safeParse({ replacesDeviceId: crypto.randomUUID() }).success).toBe(true);
    for (const bad of [{ kind: "display", name: "X" }, { kind: "counter", name: " " }, { kind: "counter", name: "x".repeat(81) },
      { kind: "counter", name: "X", replacesDeviceId: crypto.randomUUID() }, {}]) expect(JoinCodeCreate.safeParse(bad).success).toBe(false);
  });
});
