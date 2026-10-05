import { createContext, useContext, useEffect } from "react";

export type NavigationGuard = () => boolean;
export const NavigationGuardContext = createContext<{ current: Set<NavigationGuard> } | null>(null);

/** A mounted editor can protect its draft before navigation or explicit logout. */
export function useNavigationGuard(guard: NavigationGuard) {
  const slot = useContext(NavigationGuardContext);
  useEffect(() => {
    if (!slot) return;
    slot.current.add(guard);
    return () => { slot.current.delete(guard); };
  }, [slot, guard]);
}
