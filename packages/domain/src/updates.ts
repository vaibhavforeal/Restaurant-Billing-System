/**
 * Desktop auto-update. The Electron shell owns the updater (only it can install); the server stores the admin's channel
 * and relays between Settings and the shell over the utility-process message port. Messages are plain objects.
 */
export const UPDATE_CHANNELS = ["stable", "patch"] as const;
/** stable: full releases. patch: also hotfix builds, published as GitHub pre-releases, as soon as they are out. */
export type UpdateChannel = typeof UPDATE_CHANNELS[number];

export type UpdateState = "unsupported" | "idle" | "checking" | "up-to-date" | "downloading" | "ready" | "error";
export interface UpdateStatus {
  state: UpdateState;
  currentVersion: string;
  /** The version being downloaded or ready to install. */
  availableVersion: string | null;
  /** Download progress, 0–100, while downloading. */
  percent: number | null;
  checkedAt: number | null;
  /** Why updates are unavailable, or the last error. */
  message: string | null;
}

/** Server → desktop shell. */
export type ToDesktop = { type: "update-config"; channel: UpdateChannel } | { type: "update-check" } | { type: "update-install" }
  /** A verified, admin-confirmed backup staged in the data folder; the shell stops the server and restores it. */
  | { type: "restore"; path: string };
/** Desktop shell → server. */
export type ToServer = { type: "update-status"; status: UpdateStatus };

export function isToServer(value: unknown): value is ToServer {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "update-status"
    && typeof (value as { status?: { state?: unknown } }).status?.state === "string";
}
export function isToDesktop(value: unknown): value is ToDesktop {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { type?: unknown; channel?: unknown; path?: unknown };
  return (v.type === "restore" && typeof v.path === "string") || v.type === "update-check" || v.type === "update-install" || (v.type === "update-config" && (UPDATE_CHANNELS as readonly unknown[]).includes(v.channel));
}
