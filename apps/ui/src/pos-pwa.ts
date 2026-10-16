import { useSyncExternalStore } from "react";
type State = { ready: boolean; updateReady: boolean; error: string };
let state: State = { ready: false, updateReady: false, error: "" };
const listeners = new Set<() => void>();
const publish = (patch: Partial<State>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()); };
export function usePosPwa() { return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => state); }
export function startPosPwa() {
  if (location.pathname !== "/" || !import.meta.env.PROD) return;
  const manifest = document.createElement("link"); manifest.rel = "manifest"; manifest.href = "/pos/manifest.webmanifest"; document.head.append(manifest);
  if (!window.isSecureContext || !("serviceWorker" in navigator)) return;
  void navigator.serviceWorker.register("/pos-sw.js", { scope: "/", updateViaCache: "none" }).then(registration => {
    void navigator.serviceWorker.ready.then(() => publish({ ready: true }));
    if (registration.waiting) publish({ updateReady: true });
    registration.addEventListener("updatefound", () => { const worker = registration.installing; worker?.addEventListener("statechange", () => { if (worker.state === "installed" && navigator.serviceWorker.controller) publish({ updateReady: true }); }); });
  }).catch(() => publish({ error: "The browser shell could not be prepared for offline use. Check the trusted HTTPS connection." }));
}
