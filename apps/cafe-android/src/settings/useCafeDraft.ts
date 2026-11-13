import { useState } from "react";
import { CafeSettingsInput, getCafe, saveCafe, type CafeSettings } from "@masalapos/cafe-data";
import { useDb } from "../db/provider";

export type CafeErrors = Partial<Record<keyof CafeSettings, string>>;

/** Edits a copy of the cafe settings; save validates with the same schema as the data layer and shows each field's error. */
export function useCafeDraft() {
  const db = useDb();
  const [draft, setDraft] = useState<CafeSettings>(() => getCafe(db)!);
  const [errors, setErrors] = useState<CafeErrors>({});
  const [saved, setSaved] = useState(false);

  const set = <K extends keyof CafeSettings>(key: K) => (value: CafeSettings[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
    setSaved(false);
  };

  function save(): boolean {
    const parsed = CafeSettingsInput.safeParse(draft);
    if (!parsed.success) {
      const next: CafeErrors = {};
      for (const issue of parsed.error.issues) next[issue.path[0] as keyof CafeSettings] ??= issue.message;
      setErrors(next);
      return false;
    }
    setDraft(saveCafe(db, draft, Date.now()));
    setErrors({});
    setSaved(true);
    return true;
  }

  return { draft, set, errors, save, saved };
}
