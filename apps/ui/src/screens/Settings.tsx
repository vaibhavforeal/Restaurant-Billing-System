import { useEffect, useState } from "react";
import { apiFetch, session } from "../api";
import { connectWs } from "../ws";
import { SystemSettings } from "./SystemSettings";
import type { SettingsData, PrinterInfo, StationInfo, PrintJobInfo } from "../types";

const EMPTY_SETTINGS: SettingsData = { restaurantName: "", address: "", gstin: "", fssai: "", receiptFooter: "", taxInclusive: false };

const SETTINGS_FIELDS: Array<{ key: Exclude<keyof SettingsData, "taxInclusive">; label: string }> = [
  { key: "restaurantName", label: "Restaurant name" },
  { key: "address", label: "Address" },
  { key: "gstin", label: "GSTIN" },
  { key: "fssai", label: "FSSAI licence no." },
  { key: "receiptFooter", label: "Receipt footer" },
];

const EMPTY_PRINTER = { name: "", kind: "network" as const, connection: "", paperWidth: 80 as const };

export function Settings() {
  // Profile section
  const [form, setForm] = useState<SettingsData>(EMPTY_SETTINGS);
  const [profileStatus, setProfileStatus] = useState<"" | "saved" | "error">("");

  // Printers section
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [editingPrinterId, setEditingPrinterId] = useState<string | null>(null);
  const [editPrinter, setEditPrinter] = useState<Partial<PrinterInfo>>({});
  const [newPrinter, setNewPrinter] = useState<{ name: string; kind: "network" | "windows" | "bluetooth"; connection: string; paperWidth: 58 | 80 }>(EMPTY_PRINTER);

  // Stations section
  const [stations, setStations] = useState<StationInfo[]>([]);
  const [newStationName, setNewStationName] = useState("");

  // Jobs section
  const [jobs, setJobs] = useState<PrintJobInfo[]>([]);

  // Common
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

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
    } catch {
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
    setEditPrinter({ name: p.name, kind: p.kind, connection: p.connection, paperWidth: p.paperWidth });
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

  async function testPrint(printerId: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await apiFetch(`/api/printers/${printerId}/test-print`, { method: "POST" });
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
  async function retryJob(jobId: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await apiFetch(`/api/print-jobs/${jobId}/retry`, { method: "POST" });
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
      {/* Profile section */}
      <div className="panel">
        <h3>Restaurant profile</h3>
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
          <button
            className="primary" onClick={() => void saveProfile()}
            style={{ padding: 12, fontWeight: 700 }}
            disabled={!form.restaurantName.trim() || busy}
          >
            Save
          </button>
          <div style={{ minHeight: 20, color: profileStatus === "error" ? "crimson" : "green" }}>
            {profileStatus === "saved" && "Saved ✓"}
            {profileStatus === "error" && "Save failed — restaurant name is required"}
          </div>
        </div>
      </div>

      {/* Printers section */}
      <div className="panel settings-section">
        <h3>Printers</h3>
      <div style={{ color: "crimson", minHeight: 20 }}>{error}</div>
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
                        })
                      }
                    >
                      <option value="network">Network (WiFi/LAN)</option>
                      <option value="windows">USB (Windows driver)</option>
                      <option value="bluetooth">Bluetooth (COM port)</option>
                    </select>
                  </td>
                  <td>
                    <input
                      value={editPrinter.connection ?? ""}
                      placeholder={connectionPlaceholder(editPrinter.kind ?? "network")}
                      onChange={(e) => setEditPrinter({ ...editPrinter, connection: e.target.value })}
                    />
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
                    <button onClick={() => void testPrint(p.id)} disabled={busy}>Test print</button>
                    <button onClick={() => startEditPrinter(p)} disabled={busy}>Edit</button>
                    <button onClick={() => void togglePrinter(p)} disabled={busy}>{p.isActive ? "Deactivate" : "Activate"}</button>
                  </td>
                </tr>
              )
            )}
          </tbody>
        </table>

        {/* Add printer form */}
        <div className="printer-form" style={{ display: "grid", gap: 8, padding: 12, border: "1px solid #ddd", borderRadius: 4 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              placeholder="Printer name" aria-label="Printer name"
              value={newPrinter.name}
              onChange={(e) => setNewPrinter({ ...newPrinter, name: e.target.value })}
              style={{ flex: 1 }}
            />
            <select
              aria-label="Printer connection type" value={newPrinter.kind}
              onChange={(e) =>
                setNewPrinter({ ...newPrinter, kind: e.target.value as "network" | "windows" | "bluetooth" })
              }
            >
              <option value="network">Network (WiFi/LAN)</option>
              <option value="windows">USB (Windows driver)</option>
              <option value="bluetooth">Bluetooth (COM port)</option>
            </select>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              aria-label="Printer address or connection" placeholder={connectionPlaceholder(newPrinter.kind)}
              value={newPrinter.connection}
              onChange={(e) => setNewPrinter({ ...newPrinter, connection: e.target.value })}
              style={{ flex: 1 }}
            />
            <select
              aria-label="Paper width" value={newPrinter.paperWidth}
              onChange={(e) => setNewPrinter({ ...newPrinter, paperWidth: Number(e.target.value) as 58 | 80 })}
            >
              <option value={80}>80mm</option>
              <option value={58}>58mm</option>
            </select>
            <button onClick={() => void addPrinter()} disabled={busy}>Add printer</button>
          </div>
        </div>
      </div>

      {/* KOT stations section */}
      <div className="panel settings-section">
        <h3>KOT stations</h3>
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
      </div>

      {/* Print jobs section */}
      <div className="panel settings-section">
        <h3>Print jobs</h3>
        {jobs.length === 0 ? (
          <div style={{ color: "#777", padding: 12 }}>No print jobs yet.</div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {jobs.map((job) => (
              <div
                key={job.id}
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
                  <div style={{ fontSize: 14, color: "#555" }}>
                    {job.status === "done" && "✓ Done"}
                    {job.status === "queued" && "⏳ Queued"}
                    {job.status === "printing" && "⏳ Printing"}
                    {job.status === "failed" && <span style={{ color: "crimson" }}>✗ Failed: {job.error}</span>}
                  </div>
                </div>
                {job.status === "failed" && (
                  <button onClick={() => void retryJob(job.id)} style={{ padding: "6px 12px" }} disabled={busy}>
                    Retry
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      <SystemSettings />
    </div>
  );
}
