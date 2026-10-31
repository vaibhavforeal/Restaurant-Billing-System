/** Helpers for opening the hosted payment page from the Plan and devices screen. */

export const PENDING_MESSAGE = "Opening payment page…";

/** The MasalaPOS desktop app is an Electron shell; its user agent carries "Electron/<version>". Browsers never do. */
export function isDesktopShell(userAgent: string): boolean {
  return userAgent.includes("Electron");
}

/**
 * Opens the payment page from the desktop shell. The shell denies every in-app window and sends http(s) URLs to the system
 * browser, so `window.open` returns null even when the page did open; only a throw means it did not.
 */
export function openInDesktopShell(url: string, open: (url: string, target: string) => unknown): boolean {
  try { open(url, "_blank"); return true; } catch { return false; }
}

/** Tells the person looking at a blank tab what is happening while the session link is fetched. Nothing else is ever written into it. */
export function showPendingMessage(tab: Window): void {
  try { tab.document.title = PENDING_MESSAGE; tab.document.body.textContent = PENDING_MESSAGE; } catch { /* a blank tab is fine */ }
}
