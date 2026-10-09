import { useEffect, useRef, useState } from "react";
import { ApiError, apiFetch } from "./api";
import type { Order } from "./types";
import { uuid } from "./uuid";
import { WorkspaceDialog } from "./WorkspaceDialog";

const ID_PATTERN = /^[A-Za-z0-9-]+$/;

export function NewZomatoOrderDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (orderId: string) => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  // The same reference is kept for retries of one attempt, so a lost reply cannot create a second order.
  const attempt = useRef<{ id: string; clientRef: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setValue(""); setError(""); attempt.current = null;
    const timer = window.setTimeout(() => input.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  async function submit() {
    if (lock.current) return;
    const id = value.trim();
    if (id.length < 1 || id.length > 40 || !ID_PATTERN.test(id)) { setError("Enter the Zomato order ID: 1 to 40 letters, numbers or dashes"); return; }
    if (attempt.current?.id !== id) attempt.current = { id, clientRef: uuid() };
    lock.current = true; setBusy(true); setError("");
    try {
      const { order } = await apiFetch<{ order: Order }>("/api/orders", { method: "POST", body: JSON.stringify({ clientRef: attempt.current.clientRef, type: "zomato", zomatoOrderId: id }) });
      attempt.current = null;
      onCreated(order.id);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Request failed");
    } finally { lock.current = false; setBusy(false); }
  }

  return <WorkspaceDialog open={open} title="New Zomato order" onClose={onClose} busy={busy} className="zomato-new-dialog">
    <form className="zomato-new-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label>Zomato order ID<input ref={input} required disabled={busy} maxLength={40} autoComplete="off" value={value} onChange={(event) => { setValue(event.target.value); setError(""); }} /></label>
      <div className="error-message" role="alert">{error}</div>
      <button className="primary" disabled={busy || !value.trim()}>Open order</button>
    </form>
  </WorkspaceDialog>;
}
