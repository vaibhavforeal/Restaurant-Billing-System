import { useEffect, useRef, useState, type FormEvent } from "react";
import type { DeviceKind, JoinCodeIssued, LicensedDevice } from "@masalapos/domain";
import { apiFetch } from "../api";
import { countdown } from "../join-code";

const KINDS: { kind: DeviceKind; label: string }[] = [
  { kind: "counter", label: "Billing counter" },
  { kind: "kitchen", label: "Kitchen display" },
  { kind: "captain", label: "Captain" },
];

/**
 * Where an administrator gets a join code: for a new device, or to move an existing device to another browser.
 * The code is shown once, with a countdown and a QR for each address the new device can open.
 */
export function JoinCodePanel({ devices, atLimit, disabled }: { devices: LicensedDevice[]; atLimit: boolean; disabled: boolean }) {
  const [mode, setMode] = useState<"new" | "replace">("new");
  const [kind, setKind] = useState<DeviceKind>("counter");
  const [name, setName] = useState("");
  const [replaces, setReplaces] = useState("");
  const [issued, setIssued] = useState<JoinCodeIssued | null>(null);
  const [left, setLeft] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);

  useEffect(() => {
    if (!issued) return;
    const tick = () => setLeft(issued.expiresAt - Date.now());
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [issued]);
  // A device chosen for replacement may be removed while this panel is open.
  const target = devices.find((d) => d.id === replaces);

  async function create(e: FormEvent) {
    e.preventDefault();
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try {
      const body = mode === "new" ? { kind, name: name.trim() } : { replacesDeviceId: target!.id };
      setIssued(await apiFetch<JoinCodeIssued>("/api/devices/join-codes", { method: "POST", body: JSON.stringify(body) }));
      setName(""); setReplaces("");
    } catch (err) { setError(err instanceof Error ? err.message : "Could not create a join code"); }
    finally { lock.current = false; setBusy(false); }
  }

  if (issued) return <section className="join-code-issued" aria-label="Join code">
    <h4>Join code for {issued.name}</h4>
    {left > 0 ? <>
      <p className="join-code-value" aria-label={`Join code ${issued.code.split("").join(" ")}`}>{issued.code}</p>
      <p role="timer">Valid for {countdown(left)}</p>
      <p className="license-help">On the new device, open this address or scan the code, then enter the code.{issued.replacesDeviceId ? " Its old browser is signed out when the new one joins." : ""}</p>
      {issued.links.length === 0 && <p className="license-help">This PC has no network address yet. Connect it to the restaurant network first.</p>}
      <ul className="join-code-links">{issued.links.map((link) => <li key={link.url}><img src={link.qr} alt={`QR code for ${link.url}`} width={160} height={160} /><code>{link.url}</code></li>)}</ul>
    </> : <p className="license-warning" role="status">This code has expired. Create a new one.</p>}
    <button type="button" onClick={() => setIssued(null)}>Done</button>
  </section>;

  const newDisabled = disabled || busy || atLimit;
  return <form className="join-code-form" onSubmit={(e) => { void create(e); }}>
    <h4>Add a device</h4>
    <div className="license-actions" role="radiogroup" aria-label="What the code is for">
      <label><input type="radio" name="join-code-mode" checked={mode === "new"} disabled={busy} onChange={() => { setMode("new"); setError(""); }} /> New device</label>
      <label><input type="radio" name="join-code-mode" checked={mode === "replace"} disabled={busy} onChange={() => { setMode("replace"); setError(""); }} /> Replace an existing device</label>
    </div>
    {mode === "new" ? <>
      {atLimit && <p className="license-warning">Device limit reached. Remove an unused device or upgrade the plan. Replacing a device uses no extra slot.</p>}
      <div className="license-device-form">
        <label>Type<select value={kind} disabled={newDisabled} onChange={(e) => setKind(e.target.value as DeviceKind)}>
          {KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}</select></label>
        <label>Device name<input maxLength={80} value={name} placeholder="Counter 2" disabled={newDisabled} onChange={(e) => setName(e.target.value)} /></label>
        <button className="primary" disabled={newDisabled || !name.trim()}>Create join code</button>
      </div>
    </> : <>
      <p className="license-help">The new browser takes over this device's name and place. Its old browser is signed out.</p>
      <div className="license-device-form">
        <label>Device<select value={target?.id ?? ""} disabled={disabled || busy} onChange={(e) => setReplaces(e.target.value)}>
          <option value="">Choose a device</option>
          {devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        <button className="primary" disabled={disabled || busy || !target}>Create join code</button>
      </div>
    </>}
    {error && <p role="alert" className="error-message">{error}</p>}
  </form>;
}
