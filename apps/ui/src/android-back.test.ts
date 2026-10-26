import { describe, expect, it, vi } from "vitest";
import { androidBack } from "./android-back";

const dialog = (refuse = false) => ({
  close: vi.fn(),
  dispatchEvent: vi.fn((event: Event) => { if (refuse) event.preventDefault(); return !event.defaultPrevented; }),
});

describe("Android back button", () => {
  it("closes only the top dialog before navigating", () => {
    const below = dialog(), top = dialog(), navigate = vi.fn(() => true);
    expect(androidBack([below, top], navigate)).toBe(true);
    expect(top.close).toHaveBeenCalledOnce();
    expect(below.close).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
  it("lets a dialog handle its own cancel, such as staying open while busy", () => {
    const busy = dialog(true);
    expect(androidBack([busy], () => true)).toBe(true);
    expect(busy.close).not.toHaveBeenCalled();
  });
  it("navigates without dialogs and reports when the app may exit", () => {
    expect(androidBack([], () => true)).toBe(true);
    expect(androidBack([], () => false)).toBe(false);
  });
});
