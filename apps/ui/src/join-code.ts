import type { DeviceJoined, DeviceKind, DeviceMe } from "@masalapos/domain";
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

/**
 * Enters a join code and returns what kind of device this browser now is. A join can succeed on the hub while its reply
 * is lost on weak Wi-Fi; the retry is then refused as "already joined", which for this browser means it worked.
 */
export async function redeemJoinCode(code: string, api: <T>(path: string, init?: RequestInit) => Promise<T>): Promise<DeviceKind> {
  try {
    return (await api<DeviceJoined>("/api/devices/join", { method: "POST", body: JSON.stringify({ code }) })).kind;
  } catch (error) {
    if ((error as { status?: unknown } | null)?.status !== 409) throw error;
    const now = await api<DeviceMe>("/api/devices/me");
    if (now.joined && now.kind) return now.kind;
    throw error;
  }
}

/** Time left on a join code, e.g. "9:05". */
export function countdown(msLeft: number): string {
  const seconds = Math.max(0, Math.ceil(msLeft / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
