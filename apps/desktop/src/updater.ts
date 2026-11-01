import type { UpdateChannel, UpdateStatus } from "../../../packages/domain/src/updates.js";

/** The parts of electron-updater's autoUpdater the shell uses; a fake stands in for it in tests. */
export interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  logger: unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

const SIX_HOURS = 6 * 60 * 60 * 1000;

/**
 * Downloads updates in the background and installs them only when asked (Settings → Restart & update), or when MasalaPOS
 * is next quit. Patch also takes GitHub pre-releases (hotfix builds). Switching back to stable never downgrades:
 * the installation stays on its patch version until a newer stable release is out.
 */
export function createUpdater(options: {
  updater: AutoUpdaterLike | null;
  currentVersion: string;
  /** Why this build cannot update (development or Demo build, not installed); null when it can. */
  unsupportedReason: string | null;
  publish: (status: UpdateStatus) => void;
  log: (text: string) => void;
  /** Stops the POS server cleanly before the installer replaces the app. */
  beforeInstall: () => Promise<void>;
}) {
  const { updater, currentVersion, publish, log } = options;
  let status: UpdateStatus = { state: options.unsupportedReason ? "unsupported" : "idle", currentVersion, availableVersion: null, percent: null, checkedAt: null, message: options.unsupportedReason };
  let configured = false;
  let installing = false;
  const set = (patch: Partial<UpdateStatus>) => { status = { ...status, ...patch }; publish(status); };

  if (updater && !options.unsupportedReason) {
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.allowDowngrade = false;
    updater.logger = { info: (m: unknown) => log(`[update] ${String(m)}\n`), warn: (m: unknown) => log(`[update] ${String(m)}\n`), error: (m: unknown) => log(`[update] ${String(m)}\n`), debug: () => {} };
    updater.on("checking-for-update", () => set({ state: status.state === "ready" ? "ready" : "checking", message: null }));
    updater.on("update-not-available", () => set({ state: "up-to-date", availableVersion: null, percent: null, checkedAt: Date.now() }));
    updater.on("update-available", (info: { version: string }) => set({ state: "downloading", availableVersion: info.version, percent: 0, checkedAt: Date.now() }));
    updater.on("download-progress", (p: { percent: number }) => set({ state: "downloading", percent: Math.round(p.percent) }));
    updater.on("update-downloaded", (info: { version: string }) => set({ state: "ready", availableVersion: info.version, percent: 100 }));
    updater.on("error", (error: Error) => set({ state: status.state === "ready" ? "ready" : "error", message: error?.message ?? "Update failed", checkedAt: Date.now() }));
  }

  const check = () => {
    if (!updater || status.state === "unsupported" || status.state === "downloading") return;
    updater.checkForUpdates().catch((error: unknown) => set({ state: "error", message: error instanceof Error ? error.message : "Update check failed" }));
  };

  return {
    get status() { return status; },
    /** Apply the admin's channel; the first call also starts the background checks. */
    configure(channel: UpdateChannel) {
      publish(status);
      if (!updater || status.state === "unsupported") return;
      const prerelease = channel === "patch";
      const changed = updater.allowPrerelease !== prerelease;
      updater.allowPrerelease = prerelease;
      if (!configured) {
        configured = true;
        setTimeout(check, 60_000).unref?.();
        setInterval(check, SIX_HOURS).unref?.();
      } else if (changed) check();
    },
    check,
    async install() {
      if (!updater || status.state !== "ready" || installing) return;
      installing = true;
      log(`Installing update ${status.availableVersion}\n`);
      await options.beforeInstall();
      updater.quitAndInstall(true, true);
    },
  };
}
