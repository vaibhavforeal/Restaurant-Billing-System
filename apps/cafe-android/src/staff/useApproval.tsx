import { useCallback, useRef, useState, type ReactNode } from "react";
import { router, useFocusEffect } from "expo-router";
import { cafeCan, type CafePermission } from "@masalapos/cafe-data";
import { ApproveSheet } from "./ApproveSheet";
import { createGateMemory } from "./gate-memory";
import { session } from "./session";

/** The app's approvals given on entry to protected screens; see createGateMemory. */
export const gates = createGateMemory();
session.subscribe(() => gates.clear());

interface Pending { permission: CafePermission; title: string; resolve: (id: string | null) => void }

/**
 * `approve(permission)` resolves at once with the signed-in person's id when their role holds the permission (unless
 * `always` asks for a PIN anyway); otherwise it opens the Approve sheet and resolves with the approver's id, or null
 * when cancelled. Render `sheet` once in the screen.
 */
export function useApproval(): { approve(permission: CafePermission, opts: { title: string; always?: boolean }): Promise<string | null>; sheet: ReactNode } {
  const [pending, setPending] = useState<Pending | null>(null);
  const approve = useCallback((permission: CafePermission, opts: { title: string; always?: boolean }) => {
    const current = session.get().staff;
    if (current && !opts.always && cafeCan(current.role, permission)) return Promise.resolve(current.id);
    return new Promise<string | null>((resolve) => setPending({ permission, title: opts.title, resolve }));
  }, []);
  const sheet = pending ? (
    <ApproveSheet visible title={pending.title} permission={pending.permission}
      onDone={(id) => { setPending(null); pending.resolve(id); }} />
  ) : null;
  return { approve, sheet };
}

/**
 * Asks once on entry to a protected screen (Menu, a menu item, Reports, Printers, Staff). The approval lasts while the
 * same tab stays in front, so coming back from a screen pushed on top does not ask again; switching tabs or staff does.
 * A cancelled approval goes back to Bill.
 */
export function useScreenGate(permission: CafePermission, title: string): { allowed: boolean; sheet: ReactNode } {
  const { approve, sheet } = useApproval();
  const remembered = () => {
    const staff = session.get().staff;
    return staff !== null && gates.allowed(permission, staff.id);
  };
  const [allowed, setAllowed] = useState(remembered);
  const asking = useRef(false);
  useFocusEffect(useCallback(() => {
    let live = true;
    const ok = remembered();
    setAllowed(ok);
    if (!ok && !asking.current) {
      asking.current = true;
      void approve(permission, { title }).then((id) => {
        asking.current = false;
        if (!live) return;
        const staff = session.get().staff;
        if (id && staff) { gates.remember(permission, staff.id); setAllowed(true); }
        else router.navigate("/bill");
      });
    }
    return () => { live = false; asking.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- remembered reads the live session and gate memory
  }, [approve, permission, title]));
  return { allowed, sheet };
}
