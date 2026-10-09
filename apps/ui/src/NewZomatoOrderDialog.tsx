import { useEffect, useRef, useState } from "react";
import { ApiError, apiFetch } from "./api";
import type { Order } from "./types";
import { uuid } from "./uuid";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { findZomatoOrderById } from "./zomato-desk";

const ID_PATTERN = /^[A-Za-z0-9-]+$/;

export function NewZomatoOrderDialog({ open, orders, onClose, onCreated }: { open: boolean; orders: Order[]; onClose: () => void; onCreated: (orderId: string) => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [existingId, setExistingId] = useState<string | null>(null);
  const lock = useRef(false);
  // The same reference is kept for retries of one attempt, so a lost reply cannot create a second order.
  const attempt = useRef<{ id: string; clientRef: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setValue(""); setError(""); setExistingId(null); attempt.current = null;
    const timer = window.setTimeout(() => input.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  async function submit() {
    if (lock.current) return;
    const id = value.trim();
    if (id.length < 1 || id.length > 40 || !ID_PATTERN.test(id)) { setError("Enter the Zomato order ID: 1 to 40 letters, numbers or dashes"); return; }
    if (attempt.current?.id !== id) attempt.current = { id, clientRef: uuid() };
    lock.current = true; setBusy(true); setError(""); setExistingId(null);
    try {
      const { order } = await apiFetch<{ order: Order }>("/api/orders", { method: "POST", body: JSON.stringify({ clientRef: attempt.current.clientRef, type: "zomato", zomatoOrderId: id }) });
      attempt.current = null;
      onCreated(order.id);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Request failed");
      // A duplicate of an order still open here can be opened from the dialog; closed or cancelled ones only get the message.
      if (e instanceof ApiError && e.code === "zomato_duplicate") setExistingId(findZomatoOrderById(orders, id)?.id ?? null);
    } finally { lock.current = false; setBusy(false); }
  }

  return <WorkspaceDialog open={open} title="New Zomato order" onClose={onClose} busy={busy} className="zomato-new-dialog">
    <form className="zomato-new-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label>Zomato order ID<input ref={input} required disabled={busy} maxLength={40} autoComplete="off" value={value} onChange={(event) => { setValue(event.target.value); setError(""); setExistingId(null); }} /></label>
      <div className="error-message" role="alert">{error}</div>
      {existingId && <button type="button" disabled={busy} onClick={() => onCreated(existingId)}>Open order</button>}
      <button className="primary" disabled={busy || !value.trim()}>Open order</button>
    </form>
  </WorkspaceDialog>;
}
