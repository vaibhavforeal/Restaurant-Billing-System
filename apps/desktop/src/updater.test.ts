import { describe, expect, it, vi } from "vitest";
import { createUpdater, type AutoUpdaterLike } from "./updater.js";
import type { UpdateStatus } from "../../../packages/domain/src/updates.js";

function fakeUpdater() {
  const listeners = new Map<string, (...args: any[]) => void>();
  const updater: AutoUpdaterLike & { emit(event: string, ...args: any[]): void } = {
    autoDownload: false, autoInstallOnAppQuit: false, allowPrerelease: false, allowDowngrade: true, logger: null,
    on(event, listener) { listeners.set(event, listener); return updater; },
    checkForUpdates: vi.fn(async () => null),
    quitAndInstall: vi.fn(),
    emit(event, ...args) { listeners.get(event)?.(...args); },
  };
  return updater;
}
function setup(unsupportedReason: string | null = null) {
  const updater = fakeUpdater();
  const published: UpdateStatus[] = [];
  const beforeInstall = vi.fn(async () => {});
  const u = createUpdater({ updater, currentVersion: "0.7.0", unsupportedReason, publish: (s) => published.push(s), log: () => {}, beforeInstall });
  return { updater, published, beforeInstall, u };
}

describe("desktop updater", () => {
  it("downloads in the background, never downgrades, and takes pre-releases only on patch", () => {
    const { updater, u } = setup();
    expect(updater).toMatchObject({ autoDownload: true, autoInstallOnAppQuit: true, allowDowngrade: false });
    u.configure("patch");
    expect(updater.allowPrerelease).toBe(true);
    u.configure("stable");
    expect(updater.allowPrerelease).toBe(false);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1); // the channel change re-checks
  });

  it("reports progress through to ready, and installs only when ready after stopping the server", async () => {
    const { updater, published, beforeInstall, u } = setup();
    await u.install();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    updater.emit("update-available", { version: "0.7.1" });
    updater.emit("download-progress", { percent: 41.6 });
    expect(published.at(-1)).toMatchObject({ state: "downloading", availableVersion: "0.7.1", percent: 42 });
    updater.emit("update-downloaded", { version: "0.7.1" });
    updater.emit("error", new Error("network blip"));
    expect(u.status).toMatchObject({ state: "ready", availableVersion: "0.7.1" });
    await u.install();
    expect(beforeInstall).toHaveBeenCalledOnce();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it("does nothing on builds that cannot update, but says why", async () => {
    const { updater, published, u } = setup("Development builds do not update automatically.");
    u.configure("patch");
    u.check();
    await u.install();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(published.at(-1)).toMatchObject({ state: "unsupported", message: "Development builds do not update automatically." });
  });
});
