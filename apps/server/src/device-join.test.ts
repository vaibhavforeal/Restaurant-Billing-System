import { beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS, migrate, openDb, type Database } from "@masalapos/domain";
import { Devices, deviceHash } from "./devices.js";
import { JoinCodes } from "./device-join.js";

const A = "a".repeat(64), B = "b".repeat(64), C = "c".repeat(64);
const INVALID = /not valid or has expired/;

describe("join codes", () => {
  let db: Database, devices: Devices, codes: JoinCodes, now: number;
  beforeEach(() => {
    db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    now = 1_000;
    devices = new Devices(db, () => now);
    const queue = ["AAAAAA", "BBBBBB", "CCCCCC", "DDDDDD", "EEEEEE"];
    codes = new JoinCodes(db, devices, () => now, () => queue.shift()!);
    devices.add({ credentialHash: deviceHash(A)!, name: "Main counter", kind: "counter", isMain: true }, "Asha");
  });

  it("makes a code that lasts ten minutes and stores only its hash", () => {
    const issued = codes.create({ kind: "kitchen", name: "Pass" }, "Asha", null);
    expect(issued).toEqual({ code: "AAAAAA", expiresAt: 1_000 + 600_000, kind: "kitchen", name: "Pass", replacesDeviceId: null });
    expect(JSON.stringify(db.prepare("SELECT * FROM device_join_codes").all())).not.toContain("AAAAAA");
  });

  it("the default generator uses only the alphabet", () => {
    const real = new JoinCodes(db, devices, () => now);
    for (let i = 0; i < 50; i++) expect(real.create({ kind: "counter", name: `C${i}` }, "Asha", null).code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{6}$/);
  });

  it("joins a new device with the code's name and kind", () => {
    codes.create({ kind: "kitchen", name: "Pass" }, "Asha", null);
    now = 5_000;
    expect(codes.redeem("aaa aaa", B, null)).toMatchObject({ name: "Pass", kind: "kitchen", isMain: false, createdAt: 5_000, credentialHash: deviceHash(B) });
    expect(devices.events().events[0]).toMatchObject({ kind: "joined", summary: "Joined as Pass.", actorName: "Asha" });
  });

  it("gives wrong, used and expired codes the same answer", () => {
    codes.create({ kind: "counter", name: "Two" }, "Asha", null);
    expect(() => codes.redeem("ZZZZZZ", B, null)).toThrow(INVALID);
    expect(() => codes.redeem("nope", B, null)).toThrow(INVALID);
    codes.redeem("AAAAAA", B, null);
    expect(() => codes.redeem("AAAAAA", C, null)).toThrow(INVALID);
    codes.create({ kind: "counter", name: "Three" }, "Asha", null);
    now = 1_000 + 600_000;
    expect(() => codes.redeem("BBBBBB", C, null)).toThrow(INVALID);
    expect(devices.active()).toHaveLength(2);
  });

  it("refuses a browser that is already a device, without using the code", () => {
    codes.create({ kind: "counter", name: "Two" }, "Asha", null);
    expect(() => codes.redeem("AAAAAA", A, null)).toThrow(/already joined/);
    expect(codes.redeem("AAAAAA", B, null).name).toBe("Two");
  });

  it("refuses a missing or malformed credential", () => {
    codes.create({ kind: "counter", name: "Two" }, "Asha", null);
    for (const bad of [undefined, "short"]) expect(() => codes.redeem("AAAAAA", bad, null)).toThrow(/device credential is required/);
  });

  it("refuses a new-device code at the limit, when made and when used", () => {
    expect(() => codes.create({ kind: "counter", name: "Two" }, "Asha", 1)).toThrow(/Device limit reached/);
    codes.create({ kind: "counter", name: "Two" }, "Asha", 2);
    codes.create({ kind: "kitchen", name: "Pass" }, "Asha", 2);
    codes.redeem("AAAAAA", B, 2);
    expect(() => codes.redeem("BBBBBB", C, 2)).toThrow(/Device limit reached/);
    expect(devices.active()).toHaveLength(2);
    expect(codes.redeem("BBBBBB", C, 3).name).toBe("Pass");
  });

  it("a replace code works at the limit and keeps name, kind, settings and place", () => {
    now = 2_000; const pass = devices.add({ credentialHash: deviceHash(B)!, name: "Pass", kind: "kitchen" }, "Asha");
    db.prepare("UPDATE devices SET settings = '{\"x\":1}' WHERE id = ?").run(pass.id);
    db.prepare("INSERT INTO users (id, name, pin_hash, role, created_at) VALUES ('u1', 'Asha', 'x', 'admin', 1)").run();
    db.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at, device) VALUES ('t', 'u1', 1, 9999999999999, ?)").run(deviceHash(B));
    const issued = codes.create({ replacesDeviceId: pass.id }, "Asha", 2);
    expect(issued).toMatchObject({ kind: "kitchen", name: "Pass", replacesDeviceId: pass.id });
    now = 3_000;
    expect(codes.redeem(issued.code, C, 2)).toMatchObject({ id: pass.id, name: "Pass", kind: "kitchen", settings: { x: 1 }, createdAt: 2_000 });
    expect(devices.active().map((d) => d.name)).toEqual(["Main counter", "Pass"]);
    expect(db.prepare("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 0 });
    expect(devices.events().events[0]).toMatchObject({ kind: "replaced", summary: "Replaced the browser of Pass." });
  });

  it("refuses a replace code for a device that is not there, and one whose device was removed since", () => {
    expect(() => codes.create({ replacesDeviceId: crypto.randomUUID() }, "Asha", null)).toThrow(/Device not found/);
    const pass = devices.add({ credentialHash: deviceHash(B)!, name: "Pass", kind: "kitchen" }, "Asha");
    const issued = codes.create({ replacesDeviceId: pass.id }, "Asha", null);
    devices.remove(pass.id, "Asha");
    expect(() => codes.redeem(issued.code, C, null)).toThrow(INVALID);
  });

  it("a new code for the same target cancels the unused earlier one", () => {
    codes.create({ kind: "counter", name: "Two" }, "Asha", null);
    codes.create({ kind: "counter", name: "two" }, "Asha", null);
    codes.create({ kind: "kitchen", name: "Two" }, "Asha", null);
    expect(() => codes.redeem("AAAAAA", B, null)).toThrow(INVALID);
    expect(codes.redeem("BBBBBB", B, null).kind).toBe("counter");
    expect(codes.redeem("CCCCCC", C, null).kind).toBe("kitchen");
  });

  it("a removed browser joins again as the code's kind", () => {
    const old = devices.add({ credentialHash: deviceHash(B)!, name: "Old", kind: "counter" }, "Asha");
    devices.remove(old.id, "Asha");
    codes.create({ kind: "captain", name: "Tablet" }, "Asha", null);
    now = 2_000;
    expect(codes.redeem("AAAAAA", B, null)).toMatchObject({ name: "Tablet", kind: "captain" });
    expect(devices.active().map((d) => d.name)).toEqual(["Main counter", "Tablet"]);
  });

  it("clears expired codes when the next one is made", () => {
    codes.create({ kind: "counter", name: "Two" }, "Asha", null);
    now += 600_001;
    codes.create({ kind: "counter", name: "Three" }, "Asha", null);
    expect(db.prepare("SELECT count(*) AS n FROM device_join_codes").get()).toEqual({ n: 1 });
  });
});
