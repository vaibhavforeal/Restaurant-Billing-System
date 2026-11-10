import { describe, expect, it } from "vitest";
import type { DeviceKind, DeviceMe } from "@masalapos/domain";
import { codeFromLocation, countdown, gateDecision, homeForKind, redeemJoinCode } from "./join-code";

const me = (joined: boolean, kind: DeviceKind | null = null, mainPc = false): DeviceMe => ({ joined, kind, mainPc });

describe("joining a device", () => {
  it("reads the code from a join link", () => {
    expect(codeFromLocation({ pathname: "/join", hash: "#k7m2qp" })).toBe("K7M2QP");
    expect(codeFromLocation({ pathname: "/join/", hash: "#K7M2QP" })).toBe("K7M2QP");
    expect(codeFromLocation({ pathname: "/join", hash: "#nope" })).toBe("");
    expect(codeFromLocation({ pathname: "/join", hash: "" })).toBe("");
    expect(codeFromLocation({ pathname: "/", hash: "#K7M2QP" })).toBe("");
  });
  it("sends each kind of device to its screen", () => {
    expect([homeForKind("counter"), homeForKind("kitchen"), homeForKind("captain")]).toEqual(["/", "/kitchen/", "/captain/"]);
  });
  it("decides between the app and the join screen", () => {
    expect(gateDecision(me(false), false, "/")).toEqual({ show: "join", me: me(false) });
    expect(gateDecision(me(false), false, "/kitchen/")).toEqual({ show: "join", me: me(false) });
    expect(gateDecision(me(false), true, "/")).toEqual({ show: "app" });
    expect(gateDecision(me(true, "counter"), false, "/")).toEqual({ show: "app" });
    expect(gateDecision(me(true, "counter"), false, "/kitchen/")).toEqual({ show: "app" });
    expect(gateDecision(me(true, "kitchen"), false, "/join")).toEqual({ redirect: "/kitchen/" });
    expect(gateDecision(me(true, "captain"), false, "/join/")).toEqual({ redirect: "/captain/" });
    expect(gateDecision("unreachable", "unreachable", "/captain/")).toEqual({ show: "app" });
    expect(gateDecision("unreachable", false, "/")).toEqual({ show: "app" });
    expect(gateDecision(me(false), "unreachable", "/")).toEqual({ show: "app" });
  });
  describe("entering a code", () => {
    const refused = (status: number, message: string) => Object.assign(new Error(message), { status });
    /** A hub whose join route answers `join()` and whose "who am I" answers `who`. */
    const hub = (join: () => unknown, who: DeviceMe = me(false)) => {
      const calls: string[] = [];
      const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
        calls.push(`${init?.method ?? "GET"} ${path}${init?.body ? ` ${String(init.body)}` : ""}`);
        return (path === "/api/devices/me" ? who : join()) as T;
      };
      return { api, calls };
    };
    it("joins and says what kind of device this now is", async () => {
      const { api, calls } = hub(() => ({ kind: "kitchen", name: "Pass" }));
      expect(await redeemJoinCode("K7M2QP", api)).toBe("kitchen");
      expect(calls).toEqual(['POST /api/devices/join {"code":"K7M2QP"}']);
    });
    it("carries on when the join already went through and only its reply was lost", async () => {
      const { api } = hub(() => { throw refused(409, "This device has already joined."); }, me(true, "captain"));
      expect(await redeemJoinCode("K7M2QP", api)).toBe("captain");
    });
    it("reports the refusal when the device has not in fact joined", async () => {
      const full = hub(() => { throw refused(409, "Device limit reached. Remove an old device or upgrade your plan."); });
      await expect(redeemJoinCode("K7M2QP", full.api)).rejects.toThrow("Device limit reached");
      const wrong = hub(() => { throw refused(400, "That code is not valid or has expired"); }, me(true, "counter"));
      await expect(redeemJoinCode("ZZZZZZ", wrong.api)).rejects.toThrow("not valid or has expired");
      expect(wrong.calls).toHaveLength(1);
    });
  });

  it("counts down in minutes and seconds", () => {
    expect([countdown(600_000), countdown(545_000), countdown(9_400), countdown(0), countdown(-5)]).toEqual(["10:00", "9:05", "0:10", "0:00", "0:00"]);
  });
});
