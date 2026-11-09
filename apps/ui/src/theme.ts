export type Theme = "light" | "dark";
export const THEME_STORAGE_KEY = "masalapos.theme.v1";
/** Fired on this window when the theme changes, so every theme switch on screen shows the same state. */
export const THEME_EVENT = "masalapos:theme-changed";

export function readTheme(): Theme {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}

export function saveTheme(theme: Theme) {
  applyTheme(theme);
  window.dispatchEvent(new Event(THEME_EVENT));
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Theme switching still works when browser storage is unavailable.
  }
}
