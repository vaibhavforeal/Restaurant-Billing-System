import { useEffect, useState } from "react";
import { ApiError, apiFetch, session, type User } from "../api";
import { paiseToRupees } from "../money";
import type { Category, Order, OrderItem, Product } from "../types";
import { connectWs } from "../ws";
import { uuid } from "../uuid";
import { BillingPanel } from "./BillingPanel";
import { Icon } from "../Icon";
import { queuedRequests, reliablePost, subscribeQueue } from "../retry-queue";

interface DraftItem {
  clientRef: string;
  productId: string;
  variantId: string | null;
  name: string;
  pricePaise: number;
  qty: number;
  note: string;
}

export function OrderScreen({ user, orderId, onBack, onOpenOrder }: { user: User; orderId: string; onBack: () => void; onOpenOrder: (orderId: string) => void }) {
  const draftKey = `forkflow.draft.${user.id}.${orderId}`;
  function readDraft(): DraftItem[] {
    try { return JSON.parse(localStorage.getItem(draftKey) ?? localStorage.getItem(`forkflow.draft.${orderId}`) ?? "[]"); } catch { return []; }
  }
  const [order, setOrder] = useState<Order | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedCat, setSelectedCat] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftItem[]>(readDraft);
  const [, refreshQueue] = useState(0);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [search, setSearch] = useState("");

  const queuedRefs = new Set(queuedRequests(user.id).filter((r) => r.draftKey === draftKey).flatMap((r) => (JSON.parse(r.body).items as Array<{ clientRef: string }>).map((item) => item.clientRef)));

  async function reload() {
    const [o, c, p] = await Promise.all([
      apiFetch<{ order: Order }>(`/api/orders/${orderId}`),
      apiFetch<{ categories: Category[] }>("/api/categories"),
      apiFetch<{ products: Product[] }>("/api/products"),
    ]);
    setOrder(o.order);
    setCategories(c.categories.filter((cat) => cat.isActive));
    setProducts(p.products.filter((prod) => prod.isActive));
    setSelectedCat((cur) => cur ?? c.categories.filter((x) => x.isActive)[0]?.id ?? null);
  }

  useEffect(() => {
    reload().catch(() => setError("Failed to load order"));
    const refresh = () => { setDraft(readDraft()); refreshQueue((v) => v + 1); };
    const unsub = subscribeQueue(refresh);
    const acknowledged = () => { refresh(); void reload().catch(() => {}); };
    window.addEventListener("forkflow:ack", acknowledged);
    const dispose = connectWs({
      onEvent: (event, data) => {
        if (event === "order.updated" && (data as { order: Order }).order.id === orderId) void reload().catch(() => {});
        if (event === "table.changed") void reload().catch(() => {});
        if (event === "stock.changed") void reload().catch(() => {});
      },
      onStatus: (connected) => { if (connected) void reload().catch(() => {}); },
      onAuthFail: () => session.clear(),
    });
    return () => { dispose(); unsub(); window.removeEventListener("forkflow:ack", acknowledged); };
  }, [orderId, draftKey]);

  function saveDraft(next: DraftItem[]): boolean {
    try {
      localStorage.setItem(draftKey, JSON.stringify(next));
      localStorage.removeItem(`forkflow.draft.${orderId}`);
      setDraft(next); return true;
    } catch { setError("Cannot save this cart on the device. Free browser storage before adding items."); return false; }
  }

  async function run(action: () => Promise<unknown>) {
    setError("");
    try {
      await action();
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Request failed");
    }
  }

  function addToDraft(productId: string, variantId: string | null, name: string, pricePaise: number) {
    if (queuedRequests(user.id).some((r) => r.path === `/api/orders/${orderId}/bill` && !r.error)) {
      setError("A bill is queued for this order. Wait for it to finish before starting another order."); return;
    }
    saveDraft([...readDraft(), { clientRef: uuid(), productId, variantId, name, pricePaise, qty: 1, note: "" }]);
  }

  function updateDraft(clientRef: string, update: Partial<Pick<DraftItem, "qty" | "note">>) {
    if (!queuedRefs.has(clientRef)) saveDraft(readDraft().map((item) => (item.clientRef === clientRef ? { ...item, ...update } : item)));
  }

  function removeDraft(clientRef: string) {
    if (!queuedRefs.has(clientRef)) saveDraft(readDraft().filter((item) => item.clientRef !== clientRef));
  }

  function punch() {
    if (pending || draft.length === 0) return;
    setPending(true);
    run(async () => {
      const items = draft.map((d) => ({
        clientRef: d.clientRef,
        productId: d.productId,
        variantId: d.variantId,
        qty: d.qty,
        note: d.note || undefined,
      }));
      if (!saveDraft(draft)) throw new Error("Cart could not be saved");
      await reliablePost(`/api/orders/${orderId}/items`, { items }, `Punch ${items.length} cart rows`, draftKey);
      setDraft(readDraft());
    }).finally(() => setPending(false));
  }

  function cancelItem(item: OrderItem) {
    if (item.status === "pending") {
      if (!window.confirm(`Cancel ${item.name}?`)) return;
      void run(() => apiFetch(`/api/order-items/${item.id}/cancel`, { method: "POST", body: JSON.stringify({}) }));
    } else if (item.status === "sent") {
      if (user.role !== "admin" && user.role !== "cashier") return;
      const reason = window.prompt(`Cancel ${item.name}?\nReason (required):`);
      if (!reason?.trim()) return;
      void run(() => apiFetch(`/api/order-items/${item.id}/cancel`, { method: "POST", body: JSON.stringify({ reason: reason.trim() }) }));
    }
  }

  function sendToKitchen() {
    if (pending) return;
    setPending(true);
    const itemIds = order?.items.filter((item) => item.status === "pending").map((item) => item.id) ?? [];
    run(() => reliablePost(`/api/orders/${orderId}/send`, { clientRef: uuid(), itemIds }, "Send to kitchen")).finally(() => setPending(false));
  }

  function cancelOrder() {
    if (pending || !window.confirm("Cancel this entire order?")) return;
    setPending(true);
    run(async () => {
      await apiFetch(`/api/orders/${orderId}/cancel`, { method: "POST" });
      onBack();
    }).finally(() => setPending(false));
  }

  function addNote(clientRef: string) {
    const note = window.prompt("Add note (e.g. less spicy):") ?? "";
    updateDraft(clientRef, { note });
  }

  if (!order) return <p className="loading-state" role="status">Loading order…</p>;
  const query = search.toLocaleLowerCase().trim();
  const activeProducts = products.filter((p) => (selectedCat === "all" || p.categoryId === selectedCat) && `${p.name} ${p.variants.map((v) => v.name).join(" ")}`.toLocaleLowerCase().includes(query));
  const hasSentItems = order.items.some((i) => i.status === "sent");
  const canCancelOrder = order.status === "open" && !hasSentItems;
  const total = order.items.filter((i) => i.status !== "cancelled").reduce((sum, i) => sum + i.pricePaise * i.qty, 0);
  const draftTotal = draft.reduce((sum, item) => sum + item.pricePaise * item.qty, 0);

  return <section className="screen order-screen">
    <div className="page-header order-header">
      <div><h2>{order.type === "dine_in" ? `${order.tableName ?? "Table"} · ${order.splitLabel ?? "A"}` : "Parcel"}<span className={`status ${order.status}`}>{order.status}</span></h2></div>
      <div className="actions">
      {order.type === "dine_in" && order.status === "open" && <button onClick={async () => {
        if (pending) return; setError(""); setPending(true);
        try {
          const { order: newOrder } = await apiFetch<{ order: Order }>("/api/orders", { method: "POST", body: JSON.stringify({ clientRef: uuid(), type: "dine_in", tableId: order.tableId }) });
          onOpenOrder(newOrder.id);
        } catch (e) { setError(e instanceof ApiError ? e.message : "Request failed"); }
        finally { setPending(false); }
      }} disabled={pending}>+ Split</button>}
      <button onClick={onBack}>← Back</button>
      </div>
    </div>
    <div className="error-message" role="alert">{error}</div>
    {order.status !== "settled" && order.status !== "cancelled" && order.stockWarnings?.length > 0 && <div role="status" className="alert">
      <strong>Low stock — ordering is still available.</strong><ul>{order.stockWarnings.map((item) => <li key={item.id}>{item.name}: {item.qty} {item.unit} remaining</li>)}</ul>
    </div>}
    <div className={`order-layout ${order.status === "open" ? "" : "closed-order"}`}>
      {order.status === "open" && <section className="menu-browser" aria-label="Menu">
        <div className="panel-title"><h3>Menu</h3></div>
        <div className="search-field"><Icon name="search" size={17} /><input aria-label="Search menu" placeholder="Search dishes or portions…" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        <div className="tabs" aria-label="Menu categories">
          <button disabled={selectedCat === "all"} onClick={() => setSelectedCat("all")}>All items</button>
          {categories.map((c) => <button key={c.id} onClick={() => setSelectedCat(c.id)} disabled={c.id === selectedCat}>{c.name}</button>)}
        </div>
        <div className="menu-grid">{activeProducts.map((p) => {
          const variants = p.variants.filter((v) => v.isActive);
          const top = <div className="menu-card-top"><span className={`veg-indicator ${p.isVeg ? "" : "non-veg"}`}>{p.isVeg ? "VEG" : "NON-VEG"}</span></div>;
          return variants.length ? <div className="menu-card" key={p.id}>{top}<div className="menu-card-name">{p.name}</div>{variants.map((v) => <button className="variant-choice" aria-label={`Add ${p.name}, ${v.name}, ₹${paiseToRupees(v.pricePaise)}`} key={v.id} onClick={() => addToDraft(p.id, v.id, `${p.name} (${v.name})`, v.pricePaise)}><span>{v.name}</span><span>₹{paiseToRupees(v.pricePaise)} <Icon name="plus" size={13} /></span></button>)}</div>
          : <button className="menu-card" key={p.id} onClick={() => addToDraft(p.id, null, p.name, p.pricePaise)}>{top}<div className="menu-card-name">{p.name}</div><div className="menu-card-bottom"><span>₹{paiseToRupees(p.pricePaise)}</span><span className="add-indicator"><Icon name="plus" size={16} /></span></div></button>;
        })}</div>
        {!activeProducts.length && <div className="empty-state"><Icon name="search" size={32} /><h3>No menu items found</h3><p>Try another name or category.</p></div>}
      </section>}
      <aside className="order-cart" id="order-cart" aria-label="Current order">
        <div className="cart-heading"><h3>Current order</h3><Icon name={order.type === "parcel" ? "bag" : "tables"} size={18} /></div>
        {order.status === "open" && <div className="cart-section">
          <h3>Cart ({draft.length} items)</h3>
          {!draft.length && <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Select a dish.</p>}
          {draft.map((d) => <div className="cart-row" key={d.clientRef}>
            <div className="cart-row-top"><strong>{d.name}{d.note && <small>{d.note}</small>}</strong><span>₹{paiseToRupees(d.pricePaise * d.qty)}</span></div>
            <div className="cart-controls">
              <button aria-label={`Decrease ${d.name}`} disabled={queuedRefs.has(d.clientRef)} onClick={() => updateDraft(d.clientRef, { qty: Math.max(1, d.qty - 1) })}>−</button>
              <span>{d.qty}{queuedRefs.has(d.clientRef) ? " · saved to send" : ""}</span>
              <button aria-label={`Increase ${d.name}`} disabled={queuedRefs.has(d.clientRef)} onClick={() => updateDraft(d.clientRef, { qty: d.qty + 1 })}>+</button>
              <button disabled={queuedRefs.has(d.clientRef)} onClick={() => addNote(d.clientRef)}>Note</button>
              <button className="remove" aria-label={`Remove ${d.name}`} disabled={queuedRefs.has(d.clientRef)} onClick={() => removeDraft(d.clientRef)}>✕</button>
            </div>
          </div>)}
          {draft.length > 0 && <button className="primary" onClick={punch} disabled={pending || draft.length === 0}>Punch</button>}
        </div>}
        <div className="cart-section">
          <h3>Punched items</h3>
          {!order.items.length && <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>No items yet.</p>}
          {order.items.map((item) => <div className="cart-row" key={item.id} style={{ opacity: item.status === "cancelled" ? .5 : 1 }}>
            <div className="cart-row-top"><strong>{item.qty} × {item.name}{item.note && <small>{item.note}</small>}{item.cancelReason && <small className="danger-text">Cancelled: {item.cancelReason}</small>}</strong><span>₹{paiseToRupees(item.pricePaise * item.qty)}</span></div>
            <div className="cart-controls"><span className={`status ${item.status}`}>{item.status}</span>
            {order.status === "open" && item.status !== "cancelled" && (item.status === "pending" || user.role === "admin" || user.role === "cashier") && <button className="text-button remove" onClick={() => cancelItem(item)}>Cancel</button>}</div>
          </div>)}
        </div>
        <div className="cart-total"><div><span>Items subtotal</span><span>₹{paiseToRupees(total)}</span></div></div>
        {order.status === "open" && <div className="cart-actions"><button className="primary soft button-icon" onClick={sendToKitchen} disabled={pending}><Icon name="kitchen" size={17} />Send to kitchen</button>{canCancelOrder && <button className="text-button" onClick={cancelOrder} disabled={pending}>Cancel order</button>}</div>}
        {(user.role === "admin" || user.role === "cashier") && order.status !== "cancelled" && <BillingPanel order={order} hasDraft={draft.length > 0} onChanged={reload} />}
      </aside>
    </div>
    {order.status === "open" && <a className="mobile-cart-link" href="#order-cart"><span>View cart · {draft.length} new items</span><strong>₹{paiseToRupees(total + draftTotal)}</strong></a>}
  </section>;
}
