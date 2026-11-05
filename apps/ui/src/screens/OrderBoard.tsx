import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, type User } from "../api";
import { Icon } from "../Icon";
import { useIntegrations } from "../integrations";
import { useLiveRefresh } from "../live-refresh";
import { paiseToRupees } from "../money";
import { STAGE_LABEL, STAGES, groupByStage, matchesSearch, startOfLocalDay, type Stage } from "../order-board";
import { userCan } from "../permissions";
import { orderSummary } from "../table-order-summary";
import type { Order } from "../types";
import { kitchenContextLabel, useZomatoStatus, ZOMATO_PILL, zomatoAgeTone, zomatoCardAction } from "../zomato-desk";
import { useZomatoAgeThresholds } from "../ZomatoPanel";
import "../order-board.css";

type View = "overview" | Stage;

/** Takeaway, delivery and Zomato orders in stage columns, from just placed to settled today. Dine-in stays on Tables. */
export function OrderBoard({ user, onOpenOrder, onNewOrder }: { user: User; onOpenOrder: (orderId: string) => void; onNewOrder?: (() => void) | undefined }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<View>("overview");
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [, setTick] = useState(0);
  const { isEnabled } = useIntegrations();
  const kdsOn = isEnabled("kds");
  const canSettle = userCan(user, "bills.settle");
  const zomato = useZomatoStatus();
  const ageThresholds = useZomatoAgeThresholds();

  const reload = useCallback(async () => {
    try {
      const { orders } = await apiFetch<{ orders: Order[] }>(`/api/orders?closedSince=${startOfLocalDay(Date.now())}`, { cache: "no-store" });
      setOrders(orders); setLoaded(true); setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load orders.");
    }
  }, []);
  const refresh = useCallback(() => { void reload(); }, [reload]);

  useEffect(() => { refresh(); }, [refresh]);
  useLiveRefresh(refresh, { events: ["order.updated", "kot.created", "kot.updated", "zomato.changed", "integrations.changed"], debounceMs: 300, pollMs: 30000 });
  // Card ages are in minutes; repaint once a minute.
  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 60000); return () => clearInterval(t); }, []);

  // Zomato orders show only to staff who can take payment, as on Tables.
  const visible = useMemo(() => orders.filter((o) => o.type !== "zomato" || canSettle), [orders, canSettle]);
  const typeChips = useMemo(() => {
    const names = new Map<string, string>();
    for (const o of visible) if (o.type !== "dine_in") names.set(typeKey(o), typeName(o));
    return [...names].sort((a, b) => a[1].localeCompare(b[1]));
  }, [visible]);
  const filtered = visible.filter((o) => (typeFilter === "all" || typeKey(o) === typeFilter) && matchesSearch(o, query));
  const groups = groupByStage(filtered, kdsOn);
  const shown = view === "overview" ? STAGES : [view];

  async function advanceZomato(order: Order) {
    const { status } = zomatoCardAction(order);
    if (status === null) { onOpenOrder(order.id); return; }
    if (await zomato.advance(order, status)) refresh();
  }

  function card(order: Order, stage: Stage) {
    const { itemCount, subtotalPaise } = orderSummary(order);
    const minutes = Math.max(0, Math.floor(((order.closedAt ?? Date.now()) - order.openedAt) / 60000));
    const tone = stage === "processed" ? "done" : zomatoAgeTone(minutes, ageThresholds);
    const label = order.type === "zomato" ? kitchenContextLabel({ orderType: "zomato", tableName: null, splitLabel: null, zomatoOrderId: order.zomatoOrderId }) : `${typeName(order)} #${order.clientRef.slice(0, 8)}`;
    const zomatoAction = order.type === "zomato" && stage !== "processed" && canSettle ? zomatoCardAction(order) : null;
    return <li key={order.id} className={`order-card order-age-${tone}`}>
      <button type="button" className="order-card-open" onClick={() => onOpenOrder(order.id)}>
        <span className="order-card-title">{label}</span>
        {order.type === "zomato" && <span className={`zomato-desk-pill is-${order.zomatoStatus ?? "new"}`}>{ZOMATO_PILL[order.zomatoStatus ?? "new"]}</span>}
        {order.status === "billed" && <span className="order-card-pill">Awaiting payment</span>}
        {order.customer && <small className="order-card-customer">{order.customer.name}</small>}
        <small>{itemCount} {itemCount === 1 ? "item" : "items"} · {stage === "processed" ? `took ${minutes} min` : `${minutes} min`}</small>
        <strong className="pos-money">₹{paiseToRupees(subtotalPaise)}</strong>
      </button>
      {zomatoAction && <button type="button" className="order-card-action" disabled={zomato.busyId !== null} onClick={() => void advanceZomato(order)}>{zomato.busyId === order.id ? "Saving…" : zomatoAction.label}</button>}
    </li>;
  }

  return <section className="screen order-board">
    <div className="page-header">
      <div><h2>Orders</h2><p>Takeaway, delivery and Zomato orders. Today's settled orders are under Processed.</p></div>
      <div className="order-board-actions">
        {onNewOrder && <button type="button" className="primary" onClick={onNewOrder}><Icon name="plus" size={14} /> New takeaway</button>}
        <button type="button" onClick={refresh}><Icon name="refresh" size={14} /> Refresh</button>
      </div>
    </div>
    <div className="order-board-toolbar">
      <label className="order-board-search"><Icon name="search" size={14} /><input type="search" placeholder="Search order no., customer or phone" aria-label="Search orders" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
      <div className="order-board-chips" role="group" aria-label="Order type">
        {[["all", "All"] as const, ...typeChips].map(([key, name]) => <button type="button" key={key} aria-pressed={typeFilter === key} onClick={() => setTypeFilter(key)}>{name}</button>)}
      </div>
    </div>
    {error && <p className="error-message" role="alert">{error}</p>}
    {zomato.error && <p className="error-message" role="alert">{zomato.error}</p>}
    <div className="order-board-body">
      <nav className="order-board-rail" aria-label="Order stages">
        {(["overview", ...STAGES] as const).map((v) => <button type="button" key={v} aria-pressed={view === v} onClick={() => setView(v)}>
          <span>{v === "overview" ? "Overview" : STAGE_LABEL[v]}</span>
          <span className="order-board-count">{v === "overview" ? filtered.length : groups[v].length}</span>
        </button>)}
      </nav>
      <div className={`order-board-columns ${view === "overview" ? "" : "is-single"}`}>
        {shown.map((stage) => <section key={stage} className="order-board-column" aria-label={STAGE_LABEL[stage]}>
          <header><h3>{STAGE_LABEL[stage]}</h3><span className="order-board-count">{groups[stage].length}</span></header>
          {stage === "preparing" && !kdsOn && <p className="order-board-note">Turn on Kitchen Display to track cooking. Sent orders show as Prepared.</p>}
          <ul>
            {groups[stage].map((o) => card(o, stage))}
            {loaded && groups[stage].length === 0 && <li className="order-board-empty">No orders</li>}
          </ul>
        </section>)}
      </div>
    </div>
  </section>;
}

function typeKey(order: Order): string {
  return order.type === "zomato" ? "zomato" : order.orderTypeId;
}

function typeName(order: Order): string {
  return order.type === "zomato" ? "Zomato" : order.orderTypeName ?? "Takeaway";
}
