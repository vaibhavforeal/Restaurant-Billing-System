import { useEffect, useRef, useState } from "react";
import { apiFetch, session } from "../api";
import { connectWs } from "../ws";
import { SystemSettings } from "./SystemSettings";
import { LicenseSettings } from "./LicenseSettings";
import { KeyboardSettings } from "./KeyboardSettings";
import { DEFAULT_PRINT_PROFILE, PrintProfileControls, WindowsPrinterPicker } from "./PrinterControls";
import "../printer-settings.css";
import type { SettingsData, PrinterInfo, StationInfo, PrintJobInfo } from "../types";

const EMPTY_SETTINGS: SettingsData = { restaurantName: "", address: "", gstin: "", fssai: "", receiptFooter: "", taxInclusive: false, upiId: "" };

const SETTINGS_FIELDS: Array<{ key: Exclude<keyof SettingsData, "taxInclusive" | "upiId">; label: string }> = [
  { key: "restaurantName", label: "Restaurant name" },
  { key: "address", label: "Address" },
  { key: "gstin", label: "GSTIN" },
  { key: "fssai", label: "FSSAI licence no." },
  { key: "receiptFooter", label: "Receipt footer" },
];

const EMPTY_PRINTER = { name: "", kind: "network" as const, connection: "", paperWidth: 80 as const,
  receiptProfile: DEFAULT_PRINT_PROFILE, kotProfile: DEFAULT_PRINT_PROFILE };

/** `section: "plan"` opens and scrolls to Plan & devices, e.g. from a Marketplace card that needs a different plan. */
export function Settings({ section }: { section?: "plan" | undefined } = {}) {
  const planSection = useRef<HTMLDetailsElement>(null);
  // Profile section
  const [form, setForm] = useState<SettingsData>(EMPTY_SETTINGS);
  const [profileStatus, setProfileStatus] = useState<"" | "saved" | "error">("");
  const [profileError, setProfileError] = useState("");

  // Printers section
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [editingPrinterId, setEditingPrinterId] = useState<string | null>(null);
  const [editPrinter, setEditPrinter] = useState<Partial<PrinterInfo>>({});
  const [newPrinter, setNewPrinter] = useState<Omit<PrinterInfo, "id" | "isActive">>(EMPTY_PRINTER);

  // Stations section
  const [stations, setStations] = useState<StationInfo[]>([]);
  const [newStationName, setNewStationName] = useState("");

  // Jobs section
  const [jobs, setJobs] = useState<PrintJobInfo[]>([]);
  const [checkedJobs, setCheckedJobs] = useState<Record<string, boolean>>({});

  // Common
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (section !== "plan" || !planSection.current) return;
    planSection.current.open = true;
    planSection.current.scrollIntoView({ block: "start" });
  }, [section, loaded]); // the sections render only after the settings load

  // Load all data on mount
  useEffect(() => {
    void loadAll();
  }, []);

  // Connect to WS for live job updates
  useEffect(() => {
    const dispose = connectWs({
      onEvent: (event, data) => {
        if (event === "print.job") {
          const jobData = data as { job: PrintJobInfo };
          setJobs((prev) => {
            const idx = prev.findIndex((j) => j.id === jobData.job.id);
            if (idx >= 0) {
              const updated = [...prev];
              updated[idx] = jobData.job;
              return updated;
            } else {
              return [jobData.job, ...prev];
            }
          });
        }
      },
      onStatus: (connected) => {
        if (connected) {
          void loadJobs(); // Refetch on reconnect
        }
      },
      onAuthFail: () => session.clear(),
    });
    return dispose;
  }, []);

  async function loadAll() {
    try {
      const [settingsRes, printersRes, stationsRes, jobsRes] = await Promise.all([
        apiFetch<{ settings: SettingsData }>("/api/settings"),
        apiFetch<{ printers: PrinterInfo[] }>("/api/printers"),
        apiFetch<{ stations: StationInfo[] }>("/api/kot-stations"),
        apiFetch<{ jobs: PrintJobInfo[] }>("/api/print-jobs"),
      ]);
      setForm(settingsRes.settings);
      setPrinters(printersRes.printers);
      setStations(stationsRes.stations);
      setJobs(jobsRes.jobs);
      setLoaded(true);
      setError("");
    } catch {
      setError("Failed to load settings");
    }
  }

  async function loadJobs() {
    try {
      const { jobs: j } = await apiFetch<{ jobs: PrintJobInfo[] }>("/api/print-jobs");
      setJobs(j);
    } catch {
      // ignore — WS reconnect scenario
    }
  }

  // Profile actions
  async function saveProfile() {
    if (busy) return;
    setBusy(true);
    setProfileStatus("");
    try {
      const { settings } = await apiFetch<{ settings: SettingsData }>("/api/settings", {
        method: "PUT",
        body: JSON.stringify(form),
      });
      setForm(settings);
      setProfileStatus("saved");
    } catch (e) {
      setProfileError(e instanceof Error ? e.message : "Could not save restaurant settings");
      setProfileStatus("error");
    } finally {
      setBusy(false);
    }
  }

  // Printer actions
  async function addPrinter() {
    if (busy) return;
    if (!newPrinter.name.trim() || !newPrinter.connection.trim()) {
      setError("Printer name and connection are required");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await apiFetch("/api/printers", { method: "POST", body: JSON.stringify(newPrinter) });
      setNewPrinter(EMPTY_PRINTER);
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add printer");
    } finally {
      setBusy(false);
    }
  }

  function startEditPrinter(p: PrinterInfo) {
    setEditingPrinterId(p.id);
    setEditPrinter({ name: p.name, kind: p.kind, connection: p.connection, paperWidth: p.paperWidth,
      receiptProfile: p.receiptProfile, kotProfile: p.kotProfile });
  }

  async function savePrinter(id: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await apiFetch(`/api/printers/${id}`, { method: "PATCH", body: JSON.stringify(editPrinter) });
      setEditingPrinterId(null);
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update printer");
      await loadAll();
    } finally {
      setBusy(false);
    }
  }

  async function togglePrinter(p: PrinterInfo) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await apiFetch(`/api/printers/${p.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !p.isActive }),
      });
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to toggle printer");
      await loadAll();
    } finally {
      setBusy(false);
    }
  }

  async function testPrint(printerId: string, profile: "receipt" | "kot" = "receipt") {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await apiFetch(`/api/printers/${printerId}/test-print`, { method: "POST", body: JSON.stringify({ profile }) });
      await loadJobs();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Test print failed");
    } finally {
      setBusy(false);
    }
  }

  // Station actions
  async function addStation() {
    if (busy) return;
    const name = newStationName.trim();
    if (!name) {
      setError("Station name is required");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await apiFetch("/api/kot-stations", { method: "POST", body: JSON.stringify({ name }) });
      setNewStationName("");
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add station");
    } finally {
      setBusy(false);
    }
  }

  async function updateStationPrinter(stationId: string, printerId: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await apiFetch(`/api/kot-stations/${stationId}`, {
        method: "PATCH",
        body: JSON.stringify({ printerId: printerId || null }),
      });
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update station");
      await loadAll();
    } finally {
      setBusy(false);
    }
  }

  async function toggleStation(s: StationInfo) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await apiFetch(`/api/kot-stations/${s.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !s.isActive }),
      });
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to toggle station");
      await loadAll();
    } finally {
      setBusy(false);
    }
  }

  // Job actions
  async function retryJob(jobId: string, action: "retry" | "confirm-printed" = "retry") {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await apiFetch(`/api/print-jobs/${jobId}/${action}`, { method: "POST", body: JSON.stringify({ checkedPaper: checkedJobs[jobId] === true }) });
      setCheckedJobs(previous => ({ ...previous, [jobId]: false }));
      await loadJobs();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Retry failed");
    } finally {
      setBusy(false);
    }
  }

  // Helper for printer connection placeholder
  function connectionPlaceholder(kind: string): string {
    if (kind === "network") return "IP address (e.g. 192.168.1.50)";
    if (kind === "windows") return "Windows printer name";
    if (kind === "bluetooth") return "COM port (e.g. COM3)";
    return "";
  }

  const activePrinters = printers.filter((p) => p.isActive);

  if (!loaded) return <section className="panel">{error ? <><p role="alert">{error}</p><button onClick={() => void loadAll()}>Retry</button></> : <p role="status">Loading settings…</p>}</section>;

  return (
    <div className="screen settings-screen">
      <div className="page-header"><div><h2>Settings</h2></div></div>
      <details className="pos-section"><summary>Keyboard shortcuts</summary><KeyboardSettings /></details>
      {/* Profile section */}
      <details className="pos-section" open><summary>Restaurant profile</summary><div className="panel">

        <div className="settings-form">
          {SETTINGS_FIELDS.map(({ key, label }) => (
            <label key={key} style={{ display: "grid", gap: 4 }}>
              {label}
              <input value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
            </label>
          ))}
          <label style={{ display: "grid", gap: 4 }}>
            Menu price tax mode
            <select value={form.taxInclusive ? "inclusive" : "exclusive"} onChange={(e) => setForm({ ...form, taxInclusive: e.target.value === "inclusive" })} disabled={busy}>
              <option value="exclusive">Add GST at checkout</option>
              <option value="inclusive">Menu prices include GST</option>
            </select>
          </label>
          <small>Applies to new bills. Existing bills keep their original tax calculation.</small>
          <label style={{ display: "grid", gap: 4 }}>
            UPI ID for bill payments
            <input value={form.upiId} placeholder="restaurant@bank" maxLength={255}
              autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={busy}
              aria-describedby="upi-settings-help"
              onChange={(e) => { setForm({ ...form, upiId: e.target.value }); setProfileStatus(""); }} />
          </label>
          <small id="upi-settings-help">Save your restaurant’s UPI ID once to print a payment QR on new unpaid bills, with the bill amount filled in. Leave blank to disable for new bills. Existing bills keep their saved UPI ID.</small>
          <button
            className="primary" onClick={() => void saveProfile()}
            style={{ fontWeight: 700 }}
            disabled={!form.restaurantName.trim() || busy}
          >
            Save
          </button>
          <div role={profileStatus === "error" ? "alert" : "status"} style={{ minHeight: 20, color: profileStatus === "error" ? "var(--danger-text, crimson)" : "var(--success-text, green)" }}>
            {profileStatus === "saved" && "Saved ✓"}
            {profileStatus === "error" && profileError}
          </div>
        </div>
      </div></details>

      {/* Printers section */}
      <details className="pos-section"><summary>Printers</summary><div className="panel">

      <div role="alert" style={{ color: "var(--danger-text, crimson)", minHeight: 20 }}>{error}</div>
        <div className="printer-table-scroll" role="region" aria-label="Configured printers" tabIndex={0}>
        <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>
              <th style={{ padding: 6 }}>Name</th>
              <th>Kind</th>
              <th>Connection</th>
              <th>Paper</th>
              <th>Active</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {printers.map((p) =>
              editingPrinterId === p.id ? (
                <tr key={p.id} style={{ borderBottom: "1px solid #eee" }}>
                  <td style={{ padding: 6 }}>
                    <input
                      value={editPrinter.name ?? ""}
                      onChange={(e) => setEditPrinter({ ...editPrinter, name: e.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      value={editPrinter.kind ?? "network"}
                      onChange={(e) =>
                        setEditPrinter({
                          ...editPrinter,
                          kind: e.target.value as "network" | "windows" | "bluetooth",
                          connection: "",
                        })
                      }
                    >
                      <option value="network">Network (WiFi/LAN)</option>
                      <option value="windows">USB (Windows driver)</option>
                      <option value="bluetooth">Bluetooth (COM port)</option>
                    </select>
                  </td>
                  <td>
                    {editPrinter.kind === "windows" ? <WindowsPrinterPicker value={editPrinter.connection ?? ""}
                      onChange={connection => setEditPrinter(previous => ({ ...previous, connection }))} disabled={busy} /> : <input
                      value={editPrinter.connection ?? ""}
                      placeholder={connectionPlaceholder(editPrinter.kind ?? "network")}
                      onChange={(e) => setEditPrinter({ ...editPrinter, connection: e.target.value })}
                    />}
                  </td>
                  <td>
                    <select
                      value={editPrinter.paperWidth ?? 80}
                      onChange={(e) => setEditPrinter({ ...editPrinter, paperWidth: Number(e.target.value) as 58 | 80 })}
                    >
                      <option value={80}>80mm</option>
                      <option value={58}>58mm</option>
                    </select>
                  </td>
                  <td>{p.isActive ? "✓" : "—"}</td>
                  <td>
                    <button onClick={() => void savePrinter(p.id)} disabled={busy}>Save</button>
                    <button onClick={() => setEditingPrinterId(null)} disabled={busy}>Cancel</button>
                  </td>
                </tr>
              ) : (
                <tr key={p.id} style={{ borderBottom: "1px solid #eee", opacity: p.isActive ? 1 : 0.45 }}>
                  <td style={{ padding: 6 }}>{p.name}</td>
                  <td>{p.kind === "network" ? "Network" : p.kind === "windows" ? "Windows" : "Bluetooth"}</td>
                  <td>{p.connection}</td>
                  <td>{p.paperWidth}mm</td>
                  <td>{p.isActive ? "✓" : "—"}</td>
                  <td>
                    <button onClick={() => void testPrint(p.id)} disabled={busy || !p.isActive}>Test print</button>
                    <button onClick={() => void testPrint(p.id, "kot")} disabled={busy || !p.isActive}>Test KOT</button>
                    <button onClick={() => startEditPrinter(p)} disabled={busy}>Edit</button>
                    <button onClick={() => void togglePrinter(p)} disabled={busy}>{p.isActive ? "Deactivate" : "Activate"}</button>
                  </td>
                </tr>
              )
            )}
          </tbody>
        </table>
        </div>

        {editingPrinterId && <div style={{ display: "grid", gap: 12, marginBottom: 16 }}>
          <PrintProfileControls title="Bill profile" value={editPrinter.receiptProfile ?? DEFAULT_PRINT_PROFILE} disabled={busy}
            onChange={receiptProfile => setEditPrinter(previous => ({ ...previous, receiptProfile }))} />
          <PrintProfileControls title="KOT and cancellation profile" value={editPrinter.kotProfile ?? DEFAULT_PRINT_PROFILE} disabled={busy}
            onChange={kotProfile => setEditPrinter(previous => ({ ...previous, kotProfile }))} />
          <button disabled={busy} onClick={() => void savePrinter(editingPrinterId)}>Save printer and profiles</button>
          <small>Test prints use the saved profile and its copy count.</small>
        </div>}

        {/* Add printer form */}
        <div className="printer-form" style={{ display: "grid", gap: 8, padding: 12, border: "1px solid #ddd", borderRadius: 4 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "start" }}>
            <input
              placeholder="Printer name" aria-label="Printer name"
              value={newPrinter.name}
              onChange={(e) => setNewPrinter({ ...newPrinter, name: e.target.value })}
              style={{ flex: 1 }}
            />
            <select
              aria-label="Printer connection type" value={newPrinter.kind}
              onChange={(e) =>
                setNewPrinter({ ...newPrinter, kind: e.target.value as "network" | "windows" | "bluetooth", connection: "" })
              }
            >
              <option value="network">Network (WiFi/LAN)</option>
              <option value="windows">USB (Windows driver)</option>
              <option value="bluetooth">Bluetooth (COM port)</option>
            </select>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "start" }}>
            {newPrinter.kind === "windows" ? <WindowsPrinterPicker value={newPrinter.connection}
              onChange={connection => setNewPrinter(previous => ({ ...previous, connection }))} disabled={busy} /> : <input
              aria-label="Printer address or connection" placeholder={connectionPlaceholder(newPrinter.kind)}
              value={newPrinter.connection}
              onChange={(e) => setNewPrinter({ ...newPrinter, connection: e.target.value })}
              style={{ flex: 1 }}
            />}
            <select
              aria-label="Paper width" value={newPrinter.paperWidth}
              onChange={(e) => setNewPrinter({ ...newPrinter, paperWidth: Number(e.target.value) as 58 | 80 })}
            >
              <option value={80}>80mm</option>
              <option value={58}>58mm</option>
            </select>
            <PrintProfileControls title="New bill profile" value={newPrinter.receiptProfile} disabled={busy}
              onChange={receiptProfile => setNewPrinter(previous => ({ ...previous, receiptProfile }))} />
            <PrintProfileControls title="New KOT and cancellation profile" value={newPrinter.kotProfile} disabled={busy}
              onChange={kotProfile => setNewPrinter(previous => ({ ...previous, kotProfile }))} />
            <button onClick={() => void addPrinter()} disabled={busy}>Add printer</button>
          </div>
        </div>
      </div></details>

      {/* KOT stations section */}
      <details className="pos-section"><summary>KOT stations</summary><div className="panel">

        <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>
              <th style={{ padding: 6 }}>Station</th>
              <th>Printer</th>
              <th>Active</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {stations.map((s) => (
              <tr key={s.id} style={{ borderBottom: "1px solid #eee", opacity: s.isActive ? 1 : 0.45 }}>
                <td style={{ padding: 6 }}>{s.name}</td>
                <td>
                  <select
                    value={s.printerId ?? ""}
                    onChange={(e) => void updateStationPrinter(s.id, e.target.value)}
                    disabled={!s.isActive || busy}
                  >
                    <option value="">No printer</option>
                    {activePrinters.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>{s.isActive ? "✓" : "—"}</td>
                <td>
                  <button onClick={() => void toggleStation(s)} disabled={busy}>{s.isActive ? "Deactivate" : "Activate"}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Add station form */}
        <div style={{ display: "flex", gap: 8 }}>
          <input
            placeholder="Station name" aria-label="Station name"
            value={newStationName}
            onChange={(e) => setNewStationName(e.target.value)}
            style={{ flex: 1 }}
          />
          <button onClick={() => void addStation()} disabled={busy}>Add station</button>
        </div>
      </div></details>

      {/* Print jobs section */}
      <details className="pos-section"><summary>Print jobs</summary><div className="panel">
        <p>Jobs survive a restart. Submitted means the printer connection accepted the data; check the paper before retrying an uncertain copy.</p>
        {error && <p role="alert">{error}</p>}

        {jobs.length === 0 ? (
          <div style={{ color: "var(--muted)", padding: 12 }}>No print jobs yet.</div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {jobs.map((job) => (
              <div
                key={job.id}
                className="print-job-card"
                style={{
                  padding: 12,
                  border: "1px solid #ddd",
                  borderRadius: 4,
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{job.label}</div>
                  <div>{job.printerName} · Copy {job.copyNumber} of {job.copyCount}</div>
                  <div style={{ fontSize: 14, color: "var(--ink)" }}>
                    {job.status === "done" && `✓ ${job.error ?? "Submitted"}`}
                    {job.status === "queued" && "⏳ Queued"}
                    {job.status === "printing" && "⏳ Printing"}
                    {job.status === "failed" && <span style={{ color: "var(--danger-text, crimson)" }}>✗ Failed: {job.error}</span>}
                    {job.status === "unknown" && <span style={{ color: "var(--danger-text, crimson)" }}>Check paper: {job.error}</span>}
                  </div>
                </div>
                {(job.status === "failed" || job.status === "unknown") && <div style={{ display: "grid", gap: 8 }}>
                  {job.status === "unknown" && <label><input type="checkbox" checked={checkedJobs[job.id] === true}
                    onChange={event => setCheckedJobs(previous => ({ ...previous, [job.id]: event.target.checked }))} /> I checked the paper</label>}
                  <button onClick={() => void retryJob(job.id)} style={{ padding: "6px 12px" }}
                    disabled={busy || (job.status === "unknown" && !checkedJobs[job.id])}>Retry this copy</button>
                  {job.status === "unknown" && <button disabled={busy || !checkedJobs[job.id]}
                    onClick={() => void retryJob(job.id, "confirm-printed")}>Mark as already printed</button>}
                </div>}
              </div>
            ))}
          </div>
        )}
      </div></details>
      <details className="pos-section"><summary>Backups & connections</summary><SystemSettings /></details>
      <details ref={planSection} className="pos-section"><summary>Plan & devices</summary><LicenseSettings /></details>
    </div>
  );
}
