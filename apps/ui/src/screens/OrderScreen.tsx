import { useEffect, useState } from "react";
import { ApiError, apiFetch, type User } from "../api";
import { paiseToRupees } from "../money";
import type { Category, Order, OrderItem, Product } from "../types";
import { connectWs } from "../ws";

interface DraftItem {
  clientRef: string;
  productId: string;
  variantId: string | null;
  name: string;
  pricePaise: number;
  qty: number;
  note: string;
}

export function OrderScreen({ user, orderId, onBack }: { user: User; orderId: string; onBack: () => void }) {
  const [order, setOrder] = useState<Order | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedCat, setSelectedCat] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftItem[]>([]);
  const [error, setError] = useState("");

  const draftKey = `forkflow.draft.${orderId}`;

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
    const stored = localStorage.getItem(draftKey);
    if (stored) {
      try {
        setDraft(JSON.parse(stored));
      } catch {
        // ignore corrupted draft
      }
    }
    const dispose = connectWs({
      onEvent: (event, data) => {
        if (event === "order.updated" && (data as { order: Order }).order.id === orderId) void reload();
        if (event === "table.changed") void reload();
      },
      onStatus: (connected) => { if (connected) void reload(); },
    });
    return dispose;
  }, [orderId, draftKey]);

  useEffect(() => {
    localStorage.setItem(draftKey, JSON.stringify(draft));
  }, [draft, draftKey]);

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
    setDraft((d) => [...d, { clientRef: crypto.randomUUID(), productId, variantId, name, pricePaise, qty: 1, note: "" }]);
  }

  function updateDraft(clientRef: string, update: Partial<Pick<DraftItem, "qty" | "note">>) {
    setDraft((d) => d.map((item) => (item.clientRef === clientRef ? { ...item, ...update } : item)));
  }

  function removeDraft(clientRef: string) {
    setDraft((d) => d.filter((item) => item.clientRef !== clientRef));
  }

  function punch() {
    if (draft.length === 0) return;
    void run(async () => {
      const items = draft.map((d) => ({
        clientRef: d.clientRef,
        productId: d.productId,
        variantId: d.variantId,
        qty: d.qty,
        note: d.note || undefined,
      }));
      await apiFetch(`/api/orders/${orderId}/items`, { method: "POST", body: JSON.stringify({ items }) });
      setDraft([]);
      localStorage.removeItem(draftKey);
    });
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
    void run(() => apiFetch(`/api/orders/${orderId}/send`, { method: "POST" }));
  }

  function cancelOrder() {
    if (!window.confirm("Cancel this entire order?")) return;
    void run(async () => {
      await apiFetch(`/api/orders/${orderId}/cancel`, { method: "POST" });
      onBack();
    });
  }

  function addNote(clientRef: string) {
    const note = window.prompt("Add note (e.g. less spicy):") ?? "";
    updateDraft(clientRef, { note });
  }

  if (!order) return <p style={{ fontFamily: "system-ui", padding: 16 }}>Loading order...</p>;

  const activeProducts = products.filter((p) => p.categoryId === selectedCat);
  const hasSentItems = order.items.some((i) => i.status === "sent");
  const canCancelOrder = order.status === "open" && !hasSentItems;

  const total = order.items.filter((i) => i.status !== "cancelled").reduce((sum, i) => sum + i.pricePaise * i.qty, 0);

  return (
    <div style={{ fontFamily: "system-ui", padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2>
          {order.type === "dine_in" ? `Table order` : "Parcel"} — {order.status}
        </h2>
        <button onClick={onBack} style={{ padding: "8px 16px" }}>
          ← Back
        </button>
      </div>

      <div style={{ color: "crimson", minHeight: 20 }}>{error}</div>

      {order.status === "open" && (
        <>
          <div style={{ marginBottom: 16 }}>
            <h3>Products</h3>
            <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
              {categories.map((c) => (
                <button key={c.id} onClick={() => setSelectedCat(c.id)} disabled={c.id === selectedCat} style={{ padding: 6 }}>
                  {c.name}
                </button>
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12 }}>
              {activeProducts.map((p) => {
                const activeVariants = p.variants.filter((v) => v.isActive);
                if (activeVariants.length > 0) {
                  return (
                    <div key={p.id} style={{ border: "1px solid #ddd", borderRadius: 4, padding: 8 }}>
                      <div style={{ fontWeight: 700, marginBottom: 4 }}>{p.name}</div>
                      {activeVariants.map((v) => (
                        <button
                          key={v.id}
                          onClick={() => addToDraft(p.id, v.id, `${p.name} (${v.name})`, v.pricePaise)}
                          style={{ display: "block", width: "100%", marginBottom: 4, padding: 6, fontSize: 12 }}
                        >
                          {v.name} — ₹{paiseToRupees(v.pricePaise)}
                        </button>
                      ))}
                    </div>
                  );
                } else {
                  return (
                    <button
                      key={p.id}
                      onClick={() => addToDraft(p.id, null, p.name, p.pricePaise)}
                      style={{ padding: 12, fontSize: 14, border: "1px solid #ddd", borderRadius: 4 }}
                    >
                      <div style={{ fontWeight: 700 }}>{p.name}</div>
                      <div style={{ fontSize: 12 }}>₹{paiseToRupees(p.pricePaise)}</div>
                    </button>
                  );
                }
              })}
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <h3>Cart ({draft.length} items)</h3>
            {draft.length === 0 && <p style={{ color: "#777" }}>Add items from products above.</p>}
            {draft.map((d) => (
              <div key={d.clientRef} style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 0", borderBottom: "1px solid #eee" }}>
                <span style={{ flex: 1 }}>
                  {d.name}
                  {d.note && <span style={{ fontSize: 12, color: "#555" }}> ({d.note})</span>}
                </span>
                <button onClick={() => updateDraft(d.clientRef, { qty: Math.max(1, d.qty - 1) })}>−</button>
                <span>{d.qty}</span>
                <button onClick={() => updateDraft(d.clientRef, { qty: d.qty + 1 })}>+</button>
                <button onClick={() => addNote(d.clientRef)}>Note</button>
                <button onClick={() => removeDraft(d.clientRef)}>✕</button>
              </div>
            ))}
            {draft.length > 0 && (
              <button onClick={punch} style={{ marginTop: 8, padding: "10px 24px", fontWeight: 700 }}>
                Punch
              </button>
            )}
          </div>
        </>
      )}

      <div style={{ marginBottom: 16 }}>
        <h3>Punched items</h3>
        {order.items.length === 0 && <p style={{ color: "#777" }}>No items yet.</p>}
        {order.items.map((item) => (
          <div
            key={item.id}
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              padding: "8px 0",
              borderBottom: "1px solid #eee",
              opacity: item.status === "cancelled" ? 0.45 : 1,
            }}
          >
            <span style={{ flex: 1 }}>
              {item.qty} × {item.name}
              {item.note && <span style={{ fontSize: 12, color: "#555" }}> ({item.note})</span>}
              {item.cancelReason && <span style={{ fontSize: 12, color: "crimson" }}> [Cancelled: {item.cancelReason}]</span>}
            </span>
            <span
              style={{
                fontSize: 12,
                padding: "2px 6px",
                borderRadius: 4,
                backgroundColor: item.status === "pending" ? "#fff3cd" : item.status === "sent" ? "#d1ecf1" : "#f8d7da",
              }}
            >
              {item.status}
            </span>
            {item.status !== "cancelled" && (
              <button onClick={() => cancelItem(item)} disabled={item.status === "sent" && user.role !== "admin" && user.role !== "cashier"}>
                Cancel
              </button>
            )}
          </div>
        ))}
      </div>

      <div style={{ marginBottom: 16, padding: 16, backgroundColor: "#f9f9f9", borderRadius: 4 }}>
        <div style={{ fontSize: 18, fontWeight: 700 }}>Total: ₹{paiseToRupees(total)}</div>
        <div style={{ fontSize: 12, color: "#555" }}>(display only; excluding tax)</div>
      </div>

      {order.status === "open" && (
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={sendToKitchen} style={{ padding: "10px 24px", fontWeight: 700 }}>
            Send to kitchen
          </button>
          {canCancelOrder && (
            <button onClick={cancelOrder} style={{ padding: "10px 24px", backgroundColor: "#f8d7da" }}>
              Cancel order
            </button>
          )}
        </div>
      )}
    </div>
  );
}
