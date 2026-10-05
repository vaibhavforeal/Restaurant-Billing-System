export const SHORTCUT_STORAGE_KEY = "forkflow.shortcuts.v1";
export const SHORTCUT_CHANGED_EVENT = "forkflow:shortcuts-changed";
export const SHORTCUT_ACTIONS = [
  { id: "new_order", label: "New order", key: "F2", description: "Open the last-used order entry screen." },
  { id: "tables", label: "Tables", key: "F3", description: "Return to Tables & orders." },
  { id: "discount", label: "Discount / bill options", key: "F4", description: "Open discount and receipt printer options." },
  { id: "save_items", label: "Save items", key: "F6", description: "Punch draft items without sending them to the kitchen." },
  { id: "takeaway", label: "Takeaway", key: "F7", description: "Use Takeaway from Home or Tables, or Next takeaway after payment." },
  { id: "hold", label: "Hold order", key: "F8", description: "Keep the current order and return to tables." },
  { id: "send_kitchen", label: "Send to kitchen", key: "F9", description: "Save items and send their kitchen tickets." },
  { id: "billing", label: "Billing / payment", key: "F10", description: "Review the bill, then confirm the visible billing or payment step." },
] as const;
export type ShortcutAction = typeof SHORTCUT_ACTIONS[number]["id"];
export type ShortcutBindings = Record<ShortcutAction, string>;
const functionKeys = ["F2", "F3", "F4", "F6", "F7", "F8", "F9", "F10"];
// F1/F5/F11/F12 and Shift+F10 are reserved for help, refresh, browser tools,
// fullscreen and context menus. No plain character key can submit an order.
export const SHORTCUT_KEYS = [...functionKeys, ...functionKeys.filter(key => key !== "F10").map(key => `Shift+${key}`)];
export const DEFAULT_SHORTCUTS = Object.fromEntries(SHORTCUT_ACTIONS.map(action => [action.id, action.key])) as ShortcutBindings;

export function shortcutErrors(bindings: ShortcutBindings): Partial<Record<ShortcutAction, string>> {
  const errors: Partial<Record<ShortcutAction, string>> = {};
  for (const action of SHORTCUT_ACTIONS) {
    const key = bindings[action.id];
    if (typeof key !== "string" || (key !== "" && !SHORTCUT_KEYS.includes(key))) { errors[action.id] = "Choose a supported key or Disabled."; continue; }
    const other = key && SHORTCUT_ACTIONS.find(candidate => candidate.id !== action.id && bindings[candidate.id] === key);
    if (other) errors[action.id] = `${key} is also assigned to ${other.label}.`;
  }
  return errors;
}

export function decodeShortcuts(raw: string | null): { bindings: ShortcutBindings; invalid: boolean } {
  if (raw === null) return { bindings: { ...DEFAULT_SHORTCUTS }, invalid: false };
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 || !("bindings" in value) || !value.bindings || typeof value.bindings !== "object") throw new Error();
    const bindings = value.bindings as ShortcutBindings;
    if (Object.keys(bindings).length !== SHORTCUT_ACTIONS.length || Object.keys(shortcutErrors(bindings)).length) throw new Error();
    return { bindings: { ...bindings }, invalid: false };
  } catch { return { bindings: { ...DEFAULT_SHORTCUTS }, invalid: true }; }
}

export function shortcutKey(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey" | "repeat" | "isComposing">): string | null {
  if (event.ctrlKey || event.altKey || event.metaKey || event.repeat || event.isComposing) return null;
  const key = `${event.shiftKey ? "Shift+" : ""}${event.key}`;
  return SHORTCUT_KEYS.includes(key) ? key : null;
}

export function shortcutLabel(bindings: ShortcutBindings, action: ShortcutAction, label: string): string {
  return bindings[action] ? `${label} · ${bindings[action]}` : label;
}
