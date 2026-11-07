import type { SettingsData } from "./types";

/** City, state, PIN code and phone are required once set, so blanks are left out and the saved values stay. Every other field is sent, so each settings card saves the whole object without clobbering the others. */
export function settingsForSave(form: SettingsData): Partial<SettingsData> {
  const body: Partial<SettingsData> = { ...form };
  for (const key of ["city", "stateCode", "pincode", "phone"] as const) if (!form[key].trim()) delete body[key];
  return body;
}
