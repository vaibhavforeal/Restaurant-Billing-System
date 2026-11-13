import { useCallback, useRef, useState, type ReactNode } from "react";
import { router, useFocusEffect } from "expo-router";
import { cafeCan, type CafePermission } from "@masalapos/cafe-data";
import { ApproveSheet } from "./ApproveSheet";
import { session } from "./session";

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
 * Asks once when a screen gains focus (Menu, Reports, the protected parts of More) and keeps it open until the screen
 * is left. A cancelled approval goes back to Bill.
 */
export function useScreenGate(permission: CafePermission, title: string): { allowed: boolean; sheet: ReactNode } {
  const { approve, sheet } = useApproval();
  const [allowed, setAllowed] = useState(false);
  const asking = useRef(false);
  useFocusEffect(useCallback(() => {
    let live = true;
    if (!asking.current) {
      asking.current = true;
      void approve(permission, { title }).then((id) => {
        asking.current = false;
        if (!live) return;
        if (id) setAllowed(true);
        else router.navigate("/bill");
      });
    }
    return () => { live = false; asking.current = false; setAllowed(false); };
  }, [approve, permission, title]));
  return { allowed, sheet };
}
