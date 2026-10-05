import { useSyncExternalStore } from "react";

type Prompt = Event & { prompt(): Promise<void>; userChoice: Promise<unknown> };
let prompt: Prompt | null = null;
const listeners = new Set<() => void>();
const publish = () => listeners.forEach(listener => listener());
export function startKitchenPwa() {
  if (!/^\/kitchen\/?$/.test(location.pathname)) return;
  document.title = "ForkFlow Kitchen";
  const manifest = document.createElement("link"); manifest.rel = "manifest"; manifest.href = "/kitchen/manifest.webmanifest"; document.head.append(manifest);
  const icon = document.createElement("link"); icon.rel = "apple-touch-icon"; icon.href = "/kitchen/icon-192.png"; document.head.append(icon);
  window.addEventListener("beforeinstallprompt", event => { event.preventDefault(); prompt = event as Prompt; publish(); });
  window.addEventListener("appinstalled", () => { prompt = null; publish(); });
  if (window.isSecureContext && "serviceWorker" in navigator && import.meta.env.PROD) {
    void navigator.serviceWorker.register("/kitchen/sw.js", { scope: "/kitchen/", updateViaCache: "none" }).catch(() => { /* Browser use remains available. */ });
  }
}
export function KitchenInstall() {
  const ready = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => !!prompt);
  if (!ready) return null;
  return <button onClick={() => { const current = prompt; prompt = null; publish(); void current?.prompt().catch(() => {}); }}>Install Kitchen</button>;
}
