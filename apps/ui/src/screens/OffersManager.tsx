import { useEffect, useRef, useState } from "react";
import { apiFetch, ApiError } from "../api";
import { useIntegrations } from "../integrations";
import { useNavigationGuard } from "../navigation-guard";
import { WorkspaceDialog } from "../WorkspaceDialog";
import { offerForm, offerSummary, parseOfferForm, type OfferChoice, type OfferErrors, type OfferFormState, type OfferListItem } from "../offer-form";
import type { OrderTypeInfo } from "../types";
import { OfferForm } from "./OfferForm";
import "../offers.css";

type Choices = { categories: OfferChoice[]; products: OfferChoice[]; orderTypes: OrderTypeInfo[] };
export function OffersList({ offers, choices, busy, onEdit, onToggle, onDelete }: {
  offers: OfferListItem[]; choices: Choices; busy: boolean;
  onEdit: (offer: OfferListItem) => void; onToggle: (offer: OfferListItem) => void; onDelete: (offer: OfferListItem) => void;
}) {
  if (!offers.length) return <p className="offer-empty">No offers yet. Create an offer to apply deals automatically to matching bills.</p>;
  return <ul className="offer-list">{offers.map((offer) => <li className="offer-row" key={offer.id}>
    <div className="offer-row-copy"><h3>{offer.name}</h3><p>{offerSummary(offer, choices)}</p><small>{offer.bills30d} {offer.bills30d === 1 ? "bill" : "bills"} in 30 days</small></div>
    <div className="offer-row-actions">
      <button type="button" role="switch" aria-checked={offer.active} aria-label={`${offer.name} on`} disabled={busy} onClick={() => onToggle(offer)}>{offer.active ? "On" : "Off"}</button>
      <button type="button" disabled={busy} aria-label={`Edit ${offer.name}`} onClick={() => onEdit(offer)}>Edit</button>
      {offer.used ? <small>Switch it off instead</small> : <button type="button" disabled={busy} aria-label={`Delete ${offer.name}`} onClick={() => onDelete(offer)}>Delete</button>}
    </div>
  </li>)}</ul>;
}

export function OffersManager({ categories, products, onClose }: { categories: OfferChoice[]; products: OfferChoice[]; onClose: () => void }) {
  const { refresh } = useIntegrations();
  const [offers, setOffers] = useState<OfferListItem[]>([]), [orderTypes, setOrderTypes] = useState<OrderTypeInfo[]>([]);
  const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [editing, setEditing] = useState<OfferListItem | "new" | null>(null);
  const [draft, setDraft] = useState<OfferFormState>(() => offerForm()), [errors, setErrors] = useState<OfferErrors>({});
  const initial = useRef(""), lock = useRef(false), mounted = useRef(false), sequence = useRef(0);
  const dirty = editing !== null && JSON.stringify(draft) !== initial.current;

  function canLeave() {
    if (lock.current) { window.alert("Wait for the offer to finish saving."); return false; }
    return !dirty || window.confirm("Discard your unsaved offer changes?");
  }
  useNavigationGuard(canLeave);
  useEffect(() => {
    if (!dirty && !busy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, busy]);

  function apiMessage(cause: unknown) {
    if (cause instanceof ApiError && cause.code === "module_off") refresh();
    return cause instanceof Error ? cause.message : "Request failed. Try again.";
  }
  async function reload() {
    const request = ++sequence.current;
    setLoading(true); setLoadError("");
    try {
      const [data, types] = await Promise.all([
        apiFetch<{ offers: OfferListItem[] }>("/api/offers"),
        apiFetch<{ orderTypes: OrderTypeInfo[] }>("/api/order-types"),
      ]);
      if (!mounted.current || request !== sequence.current) return;
      setOffers(data.offers); setOrderTypes(types.orderTypes);
    } catch (cause) {
      if (mounted.current && request === sequence.current) setLoadError(apiMessage(cause));
    } finally {
      if (mounted.current && request === sequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => { mounted.current = false; sequence.current++; };
  }, []);

  function edit(offer: OfferListItem | "new") {
    const next = offerForm(offer === "new" ? undefined : offer);
    initial.current = JSON.stringify(next); setDraft(next); setEditing(offer); setErrors({}); setError(""); setMessage("");
  }
  function closeEditor() { if (canLeave()) { setEditing(null); setError(""); setErrors({}); } }
  async function write(path: string, method: string, body: object | undefined, success: string) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(""); setMessage("");
    try {
      await apiFetch(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!mounted.current) return;
      setEditing(null); setMessage(success);
      // reload handles its own error: a successful write must never become a retryable form submission.
      await reload();
    } catch (cause) {
      if (mounted.current) {
        setError(apiMessage(cause));
        if (cause instanceof ApiError && (cause.code === "offer_used" || cause.status === 404)) await reload();
      }
    } finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  function save() {
    if (!editing || lock.current) return;
    const result = parseOfferForm(draft);
    if (result.errors) { setErrors(result.errors); setError(""); return; }
    setErrors({});
    void write(editing === "new" ? "/api/offers" : `/api/offers/${editing.id}`, editing === "new" ? "POST" : "PUT", result.value, "Offer saved.");
  }
  const disabled = busy || loading || !!loadError;
  return <section className="panel offers-manager">
    <div className="offer-manager-header"><h2>Offers</h2><div className="offer-manager-actions"><button className="primary" disabled={disabled} onClick={() => edit("new")}>New offer</button><button disabled={busy} onClick={() => { if (canLeave()) onClose(); }}>Back to products</button></div></div>
    <p className="offer-help">Deals apply automatically to matching bills. Editing an offer changes future bills only.</p>
    {message && <p role="status">{message}</p>}
    {error && !editing && <p className="error-message" role="alert">{error}</p>}
    {loadError && <div role="alert" className="error-message">Could not refresh offers: {loadError} <button disabled={busy || loading} onClick={() => void reload()}>Retry loading offers</button></div>}
    {loading ? <p role="status">Loading offers…</p> : (!loadError || offers.length > 0) && <OffersList offers={offers} choices={{ categories, products, orderTypes }} busy={disabled}
      onEdit={edit} onToggle={(offer) => void write(`/api/offers/${offer.id}/active`, "PATCH", { active: !offer.active }, `${offer.name} switched ${offer.active ? "off" : "on"}.`)}
      onDelete={(offer) => { if (window.confirm(`Delete “${offer.name}”? This cannot be undone.`)) void write(`/api/offers/${offer.id}`, "DELETE", undefined, "Offer deleted."); }} />}
    <WorkspaceDialog open={editing !== null} title={editing === "new" ? "New offer" : "Edit offer"} busy={busy} onClose={closeEditor} className="offer-dialog">
      {editing !== null && <OfferForm value={draft} errors={errors} error={error} busy={busy} categories={categories} products={products} orderTypes={orderTypes}
        onChange={(next) => { setDraft(next); setErrors({}); setError(""); }} onSave={save} onCancel={closeEditor} />}
    </WorkspaceDialog>
  </section>;
}
