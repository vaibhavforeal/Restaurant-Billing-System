import { useEffect, useState } from "react";
import type { ZomatoSettings } from "@forkflow/domain/zomato";
import { apiFetch } from "./api";
import { paiseToRupees } from "./money";
import type { Order } from "./types";
import { connectWs } from "./ws";
import { DEFAULT_ZOMATO_AGE, useZomatoStatus, ZOMATO_PILL, zomatoAgeTone, zomatoCardAction } from "./zomato-desk";
import "./zomato.css";

/** The restaurant's amber and red minutes: loaded once, reloaded when Zomato settings change, defaults until loaded or if loading fails. */
function useZomatoAgeThresholds() {
  const [thresholds, setThresholds] = useState(DEFAULT_ZOMATO_AGE);
  useEffect(() => {
    let alive = true;
    const load = () => apiFetch<ZomatoSettings>("/api/zomato/settings", { cache: "no-store" })
      .then((s) => ({ warnMinutes: s.warnMinutes, lateMinutes: s.lateMinutes }))
      .catch(() => DEFAULT_ZOMATO_AGE)
      .then((next) => { if (alive) setThresholds(next); });
    void load();
    const disconnect = connectWs({ onEvent: (event) => { if (event === "zomato.changed") void load(); }, onStatus: () => {} });
    return () => { alive = false; disconnect(); };
  }, []);
  return thresholds;
}

/** Open Zomato orders with one-tap Ready and Picked up. The caller passes only open or billed Zomato orders, oldest first. */
export function ZomatoPanel({ orders, canCreate, disabled, onNew, onOpenOrder, onChanged }: {
  orders: Order[];
  canCreate: boolean;
  disabled: boolean;
  onNew: () => void;
  onOpenOrder: (orderId: string) => void;
  onChanged: () => void;
}) {
  const { busyId, error, advance } = useZomatoStatus();
  const ageThresholds = useZomatoAgeThresholds();

  async function act(order: Order) {
    const { status } = zomatoCardAction(order);
    if (status === null) { onOpenOrder(order.id); return; }
    if (await advance(order, status)) onChanged();
  }

  return <div className="zomato-desk">
    <div className="panel-title"><h3>Zomato</h3><span>{orders.length}</span>{canCreate && <button className="zomato-desk-new" disabled={disabled} aria-haspopup="dialog" onClick={onNew}>+ New</button>}</div>
    {error && <p className="error-message" role="alert">{error}</p>}
    <ul className="zomato-desk-list" aria-label="Zomato orders">
      {orders.map((order) => {
        const action = zomatoCardAction(order);
        const minutes = Math.max(0, Math.floor((Date.now() - order.openedAt) / 60000));
        const total = order.items.filter((item) => item.status !== "cancelled").reduce((sum, item) => sum + item.pricePaise * item.qty, 0);
        const status = order.zomatoStatus ?? "new";
        return <li key={order.id} className={`zomato-desk-card zomato-age-${zomatoAgeTone(minutes, ageThresholds)}`}>
          <button className="zomato-desk-open" disabled={disabled} onClick={() => onOpenOrder(order.id)}>
            <span className="zomato-desk-id">#{order.zomatoOrderId}</span>
            <span className={`zomato-desk-pill is-${status}`}>{ZOMATO_PILL[status]}</span>
            <small>{minutes} min</small>
            <strong className="pos-money">₹{paiseToRupees(total)}</strong>
          </button>
          <button className="zomato-desk-action" disabled={disabled || busyId !== null} onClick={() => void act(order)}>{busyId === order.id ? "Saving…" : action.label}</button>
        </li>;
      })}
      {orders.length === 0 && <li className="zomato-desk-empty">No open Zomato orders</li>}
    </ul>
  </div>;
}
