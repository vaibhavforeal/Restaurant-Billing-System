import type { CafePermission } from "@masalapos/cafe-data";

/**
 * Approvals given on entry to a protected screen (Menu, Reports, Printers, Staff). One lasts while the same tab stays
 * in front, so returning from a screen pushed on top (a menu item, a printer) does not ask again; switching tabs, or
 * any sign-in or sign-out, forgets it.
 */
export function createGateMemory() {
  const approved = new Map<CafePermission, string>();
  let tab: string | null = null;
  return {
    remember(permission: CafePermission, staffId: string) { approved.set(permission, staffId); },
    allowed(permission: CafePermission, staffId: string): boolean { return approved.get(permission) === staffId; },
    tabFocused(name: string) {
      if (name !== tab) approved.clear();
      tab = name;
    },
    clear() { approved.clear(); },
  };
}
