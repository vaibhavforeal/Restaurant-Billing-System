// The portal's one live connection (support roles only), what it knows about connected counters, and new-chat alerts.
import { useEffect, useRef, useState } from "react";
import { LiveConnection, type LiveEvent } from "./live-socket";

export const portalLive = new LiveConnection("/portal/api/live");

const online = new Set<string>();
const onlineListeners = new Set<() => void>();
portalLive.subscribe((event) => {
  if (event.type === "hello" && Array.isArray(event["counters"])) { online.clear(); for (const id of event["counters"] as string[]) online.add(id); }
  else if (event.type === "counter.online") { const id = String(event["installationId"]); if (event["online"]) online.add(id); else online.delete(id); }
  else return;
  for (const listener of onlineListeners) listener();
});
portalLive.onStatus((connected) => { if (!connected) { online.clear(); for (const listener of onlineListeners) listener(); } });

/** Calls `listener` for every live event while the component is mounted. */
export function useLiveEvent(listener: (event: LiveEvent) => void): void {
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(() => portalLive.subscribe((event) => ref.current(event)), []);
}

export function useLiveConnected(): boolean {
  const [connected, setConnected] = useState(portalLive.connected);
  useEffect(() => portalLive.onStatus(setConnected), []);
  return connected;
}

/** Whether the counter's POS has its live connection open; null until the portal itself is connected. */
export function useCounterOnline(installationId: string | undefined): boolean | null {
  const connected = useLiveConnected();
  const [, bump] = useState(0);
  useEffect(() => { const listener = () => bump((n) => n + 1); onlineListeners.add(listener); return () => { onlineListeners.delete(listener); }; }, []);
  if (!connected || !installationId) return null;
  return online.has(installationId);
}

let audio: AudioContext | null = null;
/** Two short soft notes, made on the spot (the portal loads no sound files). Browsers only allow it after the page has been used. */
export function chime(): void {
  try {
    audio ??= new AudioContext();
    const start = audio.currentTime;
    for (const [i, freq] of [660, 880].entries()) {
      const osc = audio.createOscillator(), gain = audio.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start + i * 0.16);
      gain.gain.exponentialRampToValueAtTime(0.15, start + i * 0.16 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + i * 0.16 + 0.3);
      osc.connect(gain).connect(audio.destination);
      osc.start(start + i * 0.16);
      osc.stop(start + i * 0.16 + 0.32);
    }
  } catch { /* no audio: the badge and the notification still show */ }
}

/** A desktop notification when the portal tab is in the background and alerts are allowed. */
export function notify(title: string, body: string, onClick?: () => void): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted" || document.visibilityState === "visible") return;
  const n = new Notification(title, { body, tag: "masalapos-live-chat", icon: "/portal/favicon.svg" });
  n.onclick = () => { window.focus(); onClick?.(); n.close(); };
}
