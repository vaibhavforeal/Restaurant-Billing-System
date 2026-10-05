import { useEffect, useMemo, useSyncExternalStore } from "react";
import { decodeShortcuts, shortcutErrors, shortcutKey, shortcutLabel, SHORTCUT_ACTIONS, SHORTCUT_CHANGED_EVENT, SHORTCUT_STORAGE_KEY, type ShortcutAction, type ShortcutBindings } from "./shortcut-bindings";

export function shortcutSnapshot(): string | null {
  try { return localStorage.getItem(SHORTCUT_STORAGE_KEY); } catch { return null; }
}
function subscribeShortcuts(callback: () => void) {
  const storage = (event: StorageEvent) => { if (event.key === null || event.key === SHORTCUT_STORAGE_KEY) callback(); };
  window.addEventListener("storage", storage);
  window.addEventListener(SHORTCUT_CHANGED_EVENT, callback);
  return () => { window.removeEventListener("storage", storage); window.removeEventListener(SHORTCUT_CHANGED_EVENT, callback); };
}
export function useShortcutBindings() {
  const raw = useSyncExternalStore(subscribeShortcuts, shortcutSnapshot, () => null);
  return useMemo(() => decodeShortcuts(raw).bindings, [raw]);
}
export function useShortcutLabels() {
  const bindings = useShortcutBindings();
  return {
    bindings,
    shortcut: (action: ShortcutAction, label: string) => shortcutLabel(bindings, action, label),
    shortcutProps: (action: ShortcutAction) => ({ "data-shortcut": action, "aria-keyshortcuts": bindings[action] || undefined }),
  };
}
export function saveShortcutBindings(bindings: ShortcutBindings, expected: string | null) {
  if (Object.keys(shortcutErrors(bindings)).length) throw new Error("Fix the shortcut conflicts before saving.");
  try {
    if (localStorage.getItem(SHORTCUT_STORAGE_KEY) !== expected) throw new Error("Shortcuts changed in another window. Discard changes to reload them before saving.");
    const raw = JSON.stringify({ version: 1, bindings });
    localStorage.setItem(SHORTCUT_STORAGE_KEY, raw);
    if (localStorage.getItem(SHORTCUT_STORAGE_KEY) !== raw) throw new Error();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Shortcuts changed")) throw error;
    throw new Error("Could not save shortcuts on this device. Check browser storage and try again.");
  }
  window.dispatchEvent(new Event(SHORTCUT_CHANGED_EVENT));
}

// Trigger the same enabled controls as a click; dialogs keep shortcuts in scope.
export function usePosShortcuts() {
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.defaultPrevented || (event.target instanceof Element && event.target.closest("[data-shortcut-ignore]"))) return;
      const key = shortcutKey(event);
      if (!key) return;
      const bindings = decodeShortcuts(shortcutSnapshot()).bindings;
      const action = SHORTCUT_ACTIONS.find(action => bindings[action.id] === key);
      if (!action) return;
      const dialogs = Array.from(document.querySelectorAll<HTMLDialogElement>("dialog[open]"));
      const scope = dialogs.at(-1) ?? document.querySelector(".app-shell");
      const button = Array.from(scope?.querySelectorAll<HTMLButtonElement>(`button[data-shortcut="${action.id}"]:not(:disabled)`) ?? [])
        .find(button => button.getClientRects().length && button.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }));
      if (button) { event.preventDefault(); button.click(); }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, []);
}
export function readPreference(key: string, fallback = "") {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
export function savePreference(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* Preferences are optional. */ }
}
