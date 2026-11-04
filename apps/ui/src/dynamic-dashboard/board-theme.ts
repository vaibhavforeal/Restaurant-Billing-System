import { useSyncExternalStore } from "react";

/** BoardUI switches dark mode with a `.dark` class; the POS stores its theme in `html[data-theme]`. */
export function boardThemeClass(attr: string | null | undefined): "dark" | "" {
  return attr === "dark" ? "dark" : "";
}

function subscribe(onChange: () => void) {
  if (typeof MutationObserver === "undefined") return () => undefined;
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

const read = () => boardThemeClass(typeof document === "undefined" ? null : document.documentElement.dataset["theme"]);

/** The app's current theme as BoardUI's class name; updates when the POS theme toggle changes it. */
export function useBoardThemeClass(): "dark" | "" {
  return useSyncExternalStore(subscribe, read, () => "");
}
