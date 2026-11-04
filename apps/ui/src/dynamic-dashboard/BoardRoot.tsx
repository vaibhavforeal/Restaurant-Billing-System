import { UNSAFE_PortalProvider as PortalProvider } from "react-aria";
import { createContext, useContext, useState, type ReactNode } from "react";
import { useBoardThemeClass } from "./board-theme";
import "./boardui.css";

const RootElement = createContext<HTMLElement | null>(null);

/** The element BoardUI overlays (drawers, popovers) mount into so they inherit tokens and dark mode. */
export const useBoardRootElement = () => useContext(RootElement);

/** Wraps the dashboard in the one element BoardUI styles apply to. Everything outside it is untouched. */
export function BoardRoot({ children, className = "" }: { children: ReactNode; className?: string }) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const dark = useBoardThemeClass();
  return <div ref={setElement} className={["boardui-root", dark, className].filter(Boolean).join(" ")}>
    <RootElement.Provider value={element}>
      {/* Drawers, popovers and menus mount inside the root so they get BoardUI tokens and dark mode. */}
      <PortalProvider getContainer={() => element}>{children}</PortalProvider>
    </RootElement.Provider>
  </div>;
}
