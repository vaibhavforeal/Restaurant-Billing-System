import { useEffect, useState } from "react";
import { applyTheme, readTheme, saveTheme, THEME_STORAGE_KEY, type Theme } from "./theme";

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => document.documentElement.dataset.theme === "dark" ? "dark" : "light");

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
      const next = readTheme();
      applyTheme(next);
      setTheme(next);
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  const dark = theme === "dark";
  return (
    <button
      type="button"
      className="theme-toggle"
      role="switch"
      aria-checked={dark}
      aria-label="Dark theme"
      title={`Switch to ${dark ? "light" : "dark"} theme`}
      onClick={() => {
        const next = dark ? "light" : "dark";
        saveTheme(next);
        setTheme(next);
      }}
    >
      <span className="theme-toggle-label">{dark ? "Dark" : "Light"} theme</span>
      <span className="theme-toggle-track" aria-hidden="true">
        <span className="theme-toggle-thumb">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            {dark ? <path d="M20.5 13A8.5 8.5 0 0 1 11 3.5 8.5 8.5 0 1 0 20.5 13Z" /> : <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>}
          </svg>
        </span>
      </span>
    </button>
  );
}
