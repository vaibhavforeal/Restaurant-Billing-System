import { useEffect, useState } from "react";
import { apiFetch } from "../api";
import type { SettingsData } from "../types";

const EMPTY: SettingsData = { restaurantName: "", address: "", gstin: "", fssai: "", receiptFooter: "" };

const FIELDS: Array<{ key: keyof SettingsData; label: string }> = [
  { key: "restaurantName", label: "Restaurant name" },
  { key: "address", label: "Address" },
  { key: "gstin", label: "GSTIN" },
  { key: "fssai", label: "FSSAI licence no." },
  { key: "receiptFooter", label: "Receipt footer" },
];

export function Settings() {
  const [form, setForm] = useState<SettingsData>(EMPTY);
  const [status, setStatus] = useState<"" | "saved" | "error">("");

  useEffect(() => {
    apiFetch<{ settings: SettingsData }>("/api/settings")
      .then(({ settings }) => setForm(settings))
      .catch(() => setStatus("error"));
  }, []);

  async function save() {
    setStatus("");
    try {
      const { settings } = await apiFetch<{ settings: SettingsData }>("/api/settings", {
        method: "PUT",
        body: JSON.stringify(form),
      });
      setForm(settings);
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  }

  return (
    <div style={{ maxWidth: 480, margin: "4vh auto", display: "grid", gap: 12, fontFamily: "system-ui" }}>
      <h2>Settings</h2>
      {FIELDS.map(({ key, label }) => (
        <label key={key} style={{ display: "grid", gap: 4 }}>
          {label}
          <input value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
        </label>
      ))}
      <button onClick={() => void save()} style={{ padding: 12, fontWeight: 700 }} disabled={!form.restaurantName.trim()}>
        Save
      </button>
      <div style={{ minHeight: 20, color: status === "error" ? "crimson" : "green" }}>
        {status === "saved" && "Saved ✓"}
        {status === "error" && "Save failed — restaurant name is required"}
      </div>
    </div>
  );
}
