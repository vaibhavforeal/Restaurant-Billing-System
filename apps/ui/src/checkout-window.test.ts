import { describe, expect, it, vi } from "vitest";
import { isDesktopShell, openInDesktopShell, showPendingMessage, PENDING_MESSAGE } from "./checkout-window";

describe("checkout window helpers", () => {
  it("recognises the MasalaPOS desktop shell by its Electron user agent", () => {
    expect(isDesktopShell("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) masalapos-desktop/1.0.0 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36")).toBe(true);
    expect(isDesktopShell("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")).toBe(false);
    expect(isDesktopShell("")).toBe(false);
  });

  it("hands the session URL to window.open once; the shell denies the in-app window and opens the system browser, so a null return still counts as opened", () => {
    const open = vi.fn(() => null);
    expect(openInDesktopShell("https://license.example.com/subscribe?session=abc", open)).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("https://license.example.com/subscribe?session=abc", "_blank");
  });

  it("reports failure when window.open throws so the caller can show the fallback link", () => {
    expect(openInDesktopShell("https://license.example.com/x", () => { throw new Error("blocked"); })).toBe(false);
  });

  it("writes only the one-line opening message into a blank tab", () => {
    const tab = { document: { title: "", body: { textContent: "" } } };
    showPendingMessage(tab as unknown as Window);
    expect(PENDING_MESSAGE).toBe("Opening payment page…");
    expect(tab.document.title).toBe(PENDING_MESSAGE);
    expect(tab.document.body.textContent).toBe(PENDING_MESSAGE);
  });

  it("ignores a tab whose document cannot be written", () => {
    const tab = { get document(): never { throw new DOMException("Blocked a frame", "SecurityError"); } };
    expect(() => showPendingMessage(tab as unknown as Window)).not.toThrow();
  });
});
