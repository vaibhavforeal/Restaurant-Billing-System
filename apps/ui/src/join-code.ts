import type { DeviceKind, DeviceMe } from "@masalapos/domain";
import { normalizeJoinCode } from "@masalapos/domain/devices";

const JOIN_PATH = /^\/join\/?$/;

/** The code in a join link (`/join#K7M2QP`), ready for the field; "" on any other page or when the link carries no code. */
export function codeFromLocation(location: { pathname: string; hash: string }): string {
  return JOIN_PATH.test(location.pathname) ? normalizeJoinCode(location.hash.slice(1)) ?? "" : "";
}

/** Where a device of each kind works. */
export function homeForKind(kind: DeviceKind): "/" | "/kitchen/" | "/captain/" {
  return kind === "kitchen" ? "/kitchen/" : kind === "captain" ? "/captain/" : "/";
}

/**
 * What a browser sees before sign-in: the app, the join screen, or (a joined device on a join link) its own screen.
 * When the hub cannot be reached the app is shown, so a captain tablet out of range keeps working from its saved copies.
 * A restaurant that is not set up yet has no devices, and its first browser becomes the main counter during setup.
 */
export function gateDecision(me: DeviceMe | "unreachable", needsSetup: boolean | "unreachable", pathname: string):
  { show: "app" } | { show: "join"; me: DeviceMe } | { redirect: string } {
  if (me === "unreachable" || needsSetup === "unreachable" || needsSetup) return { show: "app" };
  if (!me.joined) return { show: "join", me };
  return me.kind && JOIN_PATH.test(pathname) ? { redirect: homeForKind(me.kind) } : { show: "app" };
}

/** Time left on a join code, e.g. "9:05". */
export function countdown(msLeft: number): string {
  const seconds = Math.max(0, Math.ceil(msLeft / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
