import { useEffect, useState } from "react";
import { apiFetch } from "./api";
import { useAction } from "./use-action";
import { settingsForSave } from "./settings-save";
import type { SettingsData } from "./types";

export type SaveState = "" | "saved" | "error";

/** A settings card's own copy of the settings: loads them, edits any field, and saves the whole object so cards never clobber each other. */
export function useSettingsForm(saveFailure: string) {
  const [form, setFormState] = useState<SettingsData | null>(null);
  const [status, setStatus] = useState<SaveState>("");
  const [message, setMessage] = useState("");
  const { busy, run } = useAction();
  useEffect(() => {
    apiFetch<{ settings: SettingsData }>("/api/settings").then((r) => setFormState(r.settings))
      .catch(() => { setMessage("Failed to load settings"); setStatus("error"); });
  }, []);
  function update(patch: Partial<SettingsData>) {
    setFormState((previous) => previous && { ...previous, ...patch });
    setStatus("");
  }
  function save() {
    if (!form) return;
    setStatus("");
    void run(async () => {
      try {
        const { settings } = await apiFetch<{ settings: SettingsData }>("/api/settings", { method: "PUT", body: JSON.stringify(settingsForSave(form)) });
        setFormState(settings);
        setStatus("saved");
      } catch (e) {
        setMessage(e instanceof Error && e.message ? e.message : saveFailure);
        setStatus("error");
      }
    });
  }
  return { form, update, save, busy, status, message };
}

export function SaveStatus({ status, message }: { status: SaveState; message: string }) {
  return <div role={status === "error" ? "alert" : "status"} style={{ minHeight: 20, color: status === "error" ? "var(--danger-text, crimson)" : "var(--success-text, green)" }}>
    {status === "saved" && "Saved ✓"}
    {status === "error" && message}
  </div>;
}
