import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { GuestRequest } from "@forkflow/domain";
import { apiFetch, session } from "./api";
import { connectWs } from "./ws";
import { startQrMonitor } from "./qr-notifications";
import "./qr-notifications.css";

const SOUND_KEY = "forkflow.qr-sound.v1";
const permission = () => typeof Notification === "undefined" ? "unsupported" : Notification.permission;
const readSound = () => { try { return localStorage.getItem(SOUND_KEY) !== "off"; } catch { return true; } };
const ControlsContext = createContext<ReactNode>(null);
export function QrNotificationControls() { return useContext(ControlsContext); }

export function QrNotifications({ children, onReview, enabled }: { children: ReactNode; onReview: () => void; enabled: boolean }) {
  const [pending, setPending] = useState<GuestRequest[]>([]);
  const [error, setError] = useState(false);
  const [sound, setSound] = useState(readSound);
  const [audioReady, setAudioReady] = useState(false);
  const [desktopPermission, setDesktopPermission] = useState(permission);
  const [feedback, setFeedback] = useState("");
  const audio = useRef<AudioContext | null>(null);
  const soundEnabled = useRef(sound);
  const review = useRef(onReview);
  useEffect(() => { review.current = onReview; }, [onReview]);

  async function unlockAudio() {
    try {
      audio.current ??= new AudioContext();
      await audio.current.resume();
      setAudioReady(audio.current.state === "running");
    } catch { setAudioReady(false); }
  }
  function chime() {
    const context = audio.current;
    if (!context || context.state !== "running") return;
    for (const [offset, frequency] of [[0, 660], [0.18, 880]] as const) {
      const oscillator = context.createOscillator(), gain = context.createGain();
      const start = context.currentTime + offset;
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.14, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.25);
      oscillator.connect(gain); gain.connect(context.destination);
      oscillator.start(start); oscillator.stop(start + 0.26);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    }
  }

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let desktop: Notification | null = null;
    const unlock = () => { if (soundEnabled.current) void unlockAudio(); };
    const focused = () => setDesktopPermission(permission());
    const storage = (event: StorageEvent) => {
      if (event.key === SOUND_KEY) { soundEnabled.current = readSound(); setSound(soundEnabled.current); }
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    window.addEventListener("focus", focused);
    window.addEventListener("storage", storage);
    const dispose = startQrMonitor({
      read: async (signal) => (await apiFetch<{ requests: GuestRequest[] }>("/api/qr/requests?status=pending", { signal })).requests,
      subscribe: (refresh) => {
        window.addEventListener("focus", refresh);
        const disconnect = connectWs({
          onEvent: (event) => { if (event === "guest-request.changed") refresh(); },
          onStatus: (connected) => { if (connected) refresh(); },
          onAuthFail: () => session.clear(),
        });
        return () => { window.removeEventListener("focus", refresh); disconnect(); };
      },
      onSnapshot: (requests, arrivals) => {
        setPending(requests); setError(false);
        if (!requests.length) { desktop?.close(); desktop = null; }
        if (!arrivals.length) return;
        if (soundEnabled.current) chime();
        if (permission() === "granted" && (document.hidden || !document.hasFocus())) {
          try {
            desktop?.close();
            desktop = new Notification("New QR order", {
              body: arrivals.length === 1 ? `${arrivals[0]!.tableName} sent an order. Review it in ForkFlow.` : `${arrivals.length} new QR orders. Review them in ForkFlow.`,
              tag: "forkflow-qr-orders", silent: true,
            });
            desktop.onclick = () => { if (active) { window.focus(); review.current(); } desktop?.close(); };
          } catch { /* The in-app alert remains available if the OS blocks notifications. */ }
        }
      },
      onError: () => setError(true),
    });
    return () => {
      active = false; dispose(); desktop?.close();
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      window.removeEventListener("focus", focused);
      window.removeEventListener("storage", storage);
      void audio.current?.close().catch(() => {}); audio.current = null;
    };
  }, [enabled]);

  const controls = <div className="qr-notification-controls" aria-label="QR order notifications">
    <label><input type="checkbox" checked={sound} onChange={(event) => {
      const enabled = event.target.checked;
      soundEnabled.current = enabled; setSound(enabled);
      try { localStorage.setItem(SOUND_KEY, enabled ? "on" : "off"); } catch { /* Session preference still applies. */ }
      if (enabled) void unlockAudio();
    }} /> Sound for new QR orders</label>
    <button type="button" onClick={() => { void unlockAudio().then(() => { chime(); setFeedback(audio.current?.state === "running" ? "Test sound played." : "Sound is unavailable. Check your device audio settings."); }); }}>Test sound</button>
    {desktopPermission === "default" && <button type="button" onClick={() => {
      void Notification.requestPermission().then(setDesktopPermission).catch(() => setFeedback("Could not enable desktop alerts. Check notification permissions in your browser."));
    }}>Enable desktop alerts</button>}
    <small>{desktopPermission === "granted" ? "Desktop alerts enabled while ForkFlow is in the background." : desktopPermission === "denied" ? "Desktop alerts blocked. Allow notifications in your browser or system settings." : desktopPermission === "unsupported" ? "Desktop alerts are unavailable in this browser. In-app alerts remain enabled." : "In-app alerts are enabled on every staff screen."}</small>
    {sound && !audioReady && <small>Click Test sound to activate audio on this device.</small>}
    {feedback && <small role="status">{feedback}</small>}
  </div>;

  return <ControlsContext.Provider value={controls}>
    {(pending.length > 0 || error) && <aside className="qr-notification-banner" aria-label="QR order alerts">
      <div role="status" aria-live="polite"><strong>{pending.length > 0 ? `${pending.length}${pending.length === 500 ? "+" : ""} QR ${pending.length === 1 ? "order" : "orders"} waiting` : "QR order alerts"}</strong>
        <span>{error ? "Updates delayed. Retrying automatically." : pending.slice(0, 2).map((request) => request.tableName).join(", ") + (pending.length > 2 ? " and more" : "")}</span></div>
      <button type="button" onClick={onReview}>Review QR orders</button>
    </aside>}
    {children}
  </ControlsContext.Provider>;
}
