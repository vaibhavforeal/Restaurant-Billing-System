import { paiseToRupees } from "./money";
import type { Order } from "./types";
import { useZomatoStatus, ZOMATO_PILL, zomatoAgeTone, zomatoCardAction } from "./zomato-desk";
import "./zomato.css";

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
        return <li key={order.id} className={`zomato-desk-card zomato-age-${zomatoAgeTone(minutes)}`}>
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
