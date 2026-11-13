import { useSyncExternalStore } from "react";
import { cafeCan, type CafePermission, type Staff } from "@masalapos/cafe-data";

/** Who is using the till, kept in memory only: restarting the app always asks for a PIN again. */
export interface Session { staff: Staff | null; lastTouch: number }

export function createSessionStore(now: () => number) {
  let snap: Session = { staff: null, lastTouch: now() };
  const listeners = new Set<() => void>();
  const set = (next: Session) => {
    snap = next;
    for (const fn of [...listeners]) fn();
  };
  return {
    get: (): Session => snap,
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    signIn(staff: Staff) { set({ staff, lastTouch: now() }); },
    signOut() { if (snap.staff) set({ staff: null, lastTouch: now() }); },
    /** Records a touch without re-rendering anyone: the idle time is only read when the app comes back. */
    touch() { snap.lastTouch = now(); },
    /** True when someone is signed in and nobody touched the screen for `lockAfterMinutes`. 0 minutes means never. */
    shouldLock(lockAfterMinutes: number): boolean {
      if (!snap.staff || lockAfterMinutes <= 0) return false;
      return now() - snap.lastTouch >= lockAfterMinutes * 60_000;
    },
  };
}

export const session = createSessionStore(() => Date.now());

export function useCurrentStaff(): Staff | null {
  return useSyncExternalStore(session.subscribe, () => session.get().staff);
}

/** Whether the signed-in person's role holds a permission; false when nobody is signed in. */
export function useCan(permission: CafePermission): boolean {
  const staff = useCurrentStaff();
  return staff !== null && cafeCan(staff.role, permission);
}
