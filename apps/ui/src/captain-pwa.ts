import { useSyncExternalStore } from "react";

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}
type PwaState = { installed: boolean; installable: boolean; ready: boolean; error: string; updateReady: boolean };
let prompt: InstallPrompt | null = null;
let state: PwaState = { installed: false, installable: false, ready: false, error: "", updateReady: false };
const listeners = new Set<() => void>();
const publish = (patch: Partial<PwaState>) => { state = { ...state, ...patch }; listeners.forEach((fn) => fn()); };
export const isCaptainPath = () => /^\/captain\/?$/.test(location.pathname);
export function useCaptainPwa() { return useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => state); }
export async function installCaptain() {
  const request = prompt;
  if (!request) return;
  prompt = null; publish({ installable: false });
  try { await request.prompt(); await request.userChoice; }
  catch { publish({ error: "Use your browser's Install app or Add to Home Screen menu." }); }
}
export function startCaptainPwa() {
  if (!isCaptainPath()) return;
  document.title = "ForkFlow Captain";
  document.documentElement.dataset["captain"] = "true";
  const manifest = document.createElement("link");
  manifest.rel = "manifest"; manifest.href = "/captain/manifest.webmanifest"; document.head.append(manifest);
  const icon = document.createElement("link"); icon.rel = "apple-touch-icon"; icon.href = "/captain/icon-192.png"; document.head.append(icon);
  const display = matchMedia("(display-mode: standalone)");
  const installed = () => publish({ installed: display.matches || (navigator as Navigator & { standalone?: boolean }).standalone === true });
  installed(); display.addEventListener("change", installed);
  window.addEventListener("beforeinstallprompt", (event) => { event.preventDefault(); prompt = event as InstallPrompt; publish({ installable: true }); });
  window.addEventListener("appinstalled", () => { prompt = null; publish({ installed: true, installable: false }); });
  if (!window.isSecureContext || !("serviceWorker" in navigator) || !import.meta.env.PROD) return;
  void navigator.serviceWorker.register("/captain/sw.js", { scope: "/captain/", updateViaCache: "none" }).then((registration) => {
    void navigator.serviceWorker.ready.then(() => publish({ ready: true }));
    if (registration.waiting) publish({ updateReady: true });
    registration.addEventListener("updatefound", () => {
      const worker = registration.installing;
      worker?.addEventListener("statechange", () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller) publish({ updateReady: true });
      });
    });
  }).catch(() => publish({ error: "Offline setup could not finish. Check the trusted HTTPS connection and reopen Captain." }));
}
