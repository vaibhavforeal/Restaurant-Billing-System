import { describe, expect, it } from "vitest";
import { decodeShortcuts, DEFAULT_SHORTCUTS, shortcutErrors, shortcutKey, shortcutLabel } from "./shortcut-bindings";

const keyEvent = (key: string, extras = {}) => ({ key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, repeat: false, isComposing: false, ...extras });
describe("configurable POS shortcuts", () => {
  it("keeps existing keys and supplies independent takeaway and tables actions", () => {
    expect(decodeShortcuts(null)).toEqual({ bindings: DEFAULT_SHORTCUTS, invalid: false });
    expect(DEFAULT_SHORTCUTS).toMatchObject({ new_order: "F2", discount: "F4", save_items: "F6", hold: "F8", send_kitchen: "F9", billing: "F10", takeaway: "F7", tables: "F3" });
    expect(shortcutErrors(DEFAULT_SHORTCUTS)).toEqual({});
  });
  it("allows swapping keys and disabling actions without duplicate disabled-key errors", () => {
    const bindings = { ...DEFAULT_SHORTCUTS, new_order: "F7", takeaway: "F2", billing: "Shift+F8", save_items: "", send_kitchen: "" };
    expect(shortcutErrors(bindings)).toEqual({});
    expect(decodeShortcuts(JSON.stringify({ version: 1, bindings }))).toEqual({ bindings, invalid: false });
    expect(shortcutLabel(bindings, "billing", "Pay")).toBe("Pay · Shift+F8");
    expect(shortcutLabel(bindings, "save_items", "Punch")).toBe("Punch");
  });
  it("identifies both conflicting actions and rejects ambiguous stored bindings", () => {
    const bindings = { ...DEFAULT_SHORTCUTS, hold: "F10" };
    expect(shortcutErrors(bindings)).toEqual({ hold: "F10 is also assigned to Billing / payment.", billing: "F10 is also assigned to Hold order." });
    expect(decodeShortcuts(JSON.stringify({ version: 1, bindings }))).toEqual({ bindings: DEFAULT_SHORTCUTS, invalid: true });
  });
  it.each(["not json", "null", "[]", '{"version":2,"bindings":{}}', JSON.stringify({ version: 1, bindings: { ...DEFAULT_SHORTCUTS, billing: "Enter" } }), JSON.stringify({ version: 1, bindings: { billing: "F10" } }), JSON.stringify({ version: 1, bindings: { ...DEFAULT_SHORTCUTS, extra: "F2" } })])("falls back safely for invalid stored configuration: %s", raw => {
    expect(decodeShortcuts(raw)).toEqual({ bindings: DEFAULT_SHORTCUTS, invalid: true });
  });
  it("matches modifiers exactly and ignores composition and repeated keydown events", () => {
    expect(shortcutKey(keyEvent("F8"))).toBe("F8");
    expect(shortcutKey(keyEvent("F8", { shiftKey: true }))).toBe("Shift+F8");
    for (const flag of ["ctrlKey", "altKey", "metaKey", "repeat", "isComposing"]) expect(shortcutKey(keyEvent("F8", { [flag]: true }))).toBeNull();
  });
  it("leaves typing, navigation, and reserved browser keys alone", () => {
    for (const key of ["a", "1", "Enter", "Escape", "Tab", "ArrowDown", "F1", "F5", "F11", "F12"]) expect(shortcutKey(keyEvent(key))).toBeNull();
    expect(shortcutKey(keyEvent("F10", { shiftKey: true }))).toBeNull();
  });
});
