import { useEffect, useRef, useState } from "react";
import { ApiError, apiFetch, type User } from "../api";
import { useNavigationGuard } from "../navigation-guard";
import type { Order } from "../types";
import { uuid } from "../uuid";
import { OrderScreen } from "./OrderScreen";

interface SavedTakeaway {
  version: 1;
  clientRef: string;
  orderId: string | null;
  generation: string;
}

class TakeawayRecoveryError extends Error {}

function readSaved(key: string): SavedTakeaway | null {
  let raw: string | null;
  try { raw = localStorage.getItem(key); }
  catch { throw new TakeawayRecoveryError("Device storage is unavailable. Enable browser storage before opening a takeaway."); }
  if (raw === null) return null;
  try {
    const saved = JSON.parse(raw) as Partial<SavedTakeaway> | null;
    if (!saved || saved.version !== 1 || typeof saved.clientRef !== "string" || !saved.clientRef ||
      typeof saved.generation !== "string" || !saved.generation ||
      (saved.orderId !== null && (typeof saved.orderId !== "string" || !saved.orderId))) throw new Error();
    return saved as SavedTakeaway;
  } catch {
    throw new TakeawayRecoveryError("The saved takeaway could not be read. Review Open takeaways in Tables & orders before clearing browser data.");
  }
}

function writeSaved(key: string, saved: SavedTakeaway) {
  try {
    const raw = JSON.stringify(saved);
    localStorage.setItem(key, raw);
    if (localStorage.getItem(key) !== raw) throw new Error();
  } catch {
    throw new TakeawayRecoveryError("Cannot save this takeaway on the device. Free browser storage, then retry to recover the same order.");
  }
}

function checkCurrent(key: string, expected: SavedTakeaway) {
  const saved = readSaved(key);
  if (!saved || saved.clientRef !== expected.clientRef || saved.generation !== expected.generation) {
    throw new TakeawayRecoveryError("The saved takeaway changed in another window or after a restore. Retry to open the current saved order.");
  }
}

function checkOrder(order: Order, saved: SavedTakeaway) {
  if (!order || order.type !== "parcel" || order.clientRef !== saved.clientRef || !order.id ||
    (saved.orderId !== null && order.id !== saved.orderId)) {
    throw new TakeawayRecoveryError("The server returned a different order. Review Open takeaways in Tables & orders before continuing.");
  }
}

// Holding releases only the current shortcut. The order, cart draft, and saved
// requests remain available when the staff member reopens it from the order list.
export function releaseHeldTakeaway(userId: string, orderId: string) {
  const key = `forkflow.draft.takeaway.${userId}`;
  const saved = readSaved(key);
  if (saved?.orderId !== orderId) return;
  try {
    localStorage.removeItem(key);
    if (localStorage.getItem(key) !== null) throw new Error();
  } catch { throw new TakeawayRecoveryError("Could not hold this takeaway. Check browser storage and try again."); }
}

export function QuickTakeaway({ user, onBack, onOpenOrder }: {
  user: User;
  onBack: () => void;
  onOpenOrder: (orderId: string) => void;
}) {
  const [activeOrder, setActiveOrder] = useState<Order | null>(null);
  if (user.role !== "admin" && user.role !== "cashier") {
    return <section className="screen"><h2>Takeaway</h2><p role="alert">Quick billing is available to cashiers and administrators.</p><button onClick={onBack}>Back to tables</button></section>;
  }
  // The loading component owns its navigation guard only while OrderScreen is
  // unmounted, so it cannot replace the cart/payment guard on the order screen.
  return activeOrder
    ? <OrderScreen key={activeOrder.id} user={user} orderId={activeOrder.id} onBack={onBack} onOpenOrder={onOpenOrder} quickBilling onHold={() => { releaseHeldTakeaway(user.id, activeOrder.id); onBack(); }} onNextTakeaway={() => setActiveOrder(null)} />
    : <TakeawayStart key={user.id} user={user} onBack={onBack} onReady={setActiveOrder} />;
}

function TakeawayStart({ user, onBack, onReady }: { user: User; onBack: () => void; onReady: (order: Order) => void }) {
  const key = `forkflow.draft.takeaway.${user.id}`;
  const lock = useRef(false);
  const mounted = useRef(false);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState("");

  function canLeave() {
    if (!lock.current) return true;
    window.alert("Wait for the takeaway to finish opening before leaving.");
    return false;
  }
  useNavigationGuard(canLeave);
  useEffect(() => {
    if (!pending) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pending]);

  async function openTakeaway() {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setError("");
    try {
      // Check the restore generation before replaying an ambiguous create. The
      // shared connection queue archives this draft prefix after a restore.
      let previousGeneration: string | null;
      try { previousGeneration = localStorage.getItem("forkflow.generation"); }
      catch { throw new TakeawayRecoveryError("Device storage is unavailable. Enable browser storage before opening a takeaway."); }
      const { generation } = await apiFetch<{ generation: string }>("/api/system/generation");
      if (!mounted.current) return;
      if (!generation || typeof generation !== "string") throw new TakeawayRecoveryError("Could not verify the server connection. Retry before opening a takeaway.");
      let saved = readSaved(key);
      if ((previousGeneration && previousGeneration !== generation) || (saved && saved.generation !== generation)) {
        throw new TakeawayRecoveryError("The server was restored from backup. Reopen the app and review open orders before starting a takeaway.");
      }
      const fresh = (): SavedTakeaway => ({ version: 1, clientRef: uuid(), orderId: null, generation });
      if (!saved) { saved = fresh(); writeSaved(key, saved); }

      async function create(draft: SavedTakeaway) {
        // Persist and verify BEFORE POST, even on retry. A failed response or a
        // failed order-id write leaves the same clientRef available for replay.
        checkCurrent(key, draft);
        writeSaved(key, draft);
        return (await apiFetch<{ order: Order }>("/api/orders", {
          method: "POST", body: JSON.stringify({ clientRef: draft.clientRef, type: "parcel", tableId: null }),
        })).order;
      }

      let order = saved.orderId
        ? (await apiFetch<{ order: Order }>(`/api/orders/${encodeURIComponent(saved.orderId)}`)).order
        : await create(saved);
      if (!mounted.current) return;
      checkCurrent(key, saved);
      checkOrder(order, saved);
      if (order.status === "settled" || order.status === "cancelled") {
        // Re-entering the page or choosing Next takeaway only advances once the
        // saved order is confirmed complete by the server.
        saved = fresh();
        writeSaved(key, saved);
        order = await create(saved);
        if (!mounted.current) return;
        checkCurrent(key, saved);
        checkOrder(order, saved);
      }
      if (saved.orderId !== order.id) writeSaved(key, { ...saved, orderId: order.id });
      onReady(order);
    } catch (e) {
      if (mounted.current) {
        setError(e instanceof TakeawayRecoveryError ? e.message : e instanceof ApiError
          ? e.status === 404 ? "The saved takeaway is unavailable. Review Open takeaways in Tables & orders before starting another." : `${e.message}. Retry to recover the same takeaway.`
          : "Could not open the takeaway. Check the server connection, then retry to recover the same order.");
      }
    } finally {
      lock.current = false;
      if (mounted.current) setPending(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    void openTakeaway();
    return () => { mounted.current = false; };
  }, [user.id]);

  return <section className="screen">
    <div className="page-header"><h2>Takeaway</h2><button disabled={pending} onClick={() => { if (canLeave()) onBack(); }}>Back to tables</button></div>
    {pending ? <p className="loading-state" role="status">Opening your takeaway…</p> : <div className="panel">
      <p className="error-message" role="alert">{error}</p>
      <p className="muted">Your saved takeaway will be recovered before a new one is started.</p>
      <button className="primary" onClick={() => void openTakeaway()}>Retry opening takeaway</button>
    </div>}
  </section>;
}
