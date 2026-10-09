import { Icon } from "./Icon";
import type { AlertRow } from "./dashboard-data";
import { alertBadge, statusText } from "./dashboard-view";
import { reportMoney } from "./sales-report";

export interface OperationalAlert { key: string; message: string }
const channelName: Record<AlertRow["channel"], string> = { zomato: "Zomato", swiggy: "Swiggy" };

/**
 * Open Zomato orders first (oldest at the top; clicking one opens Tables, where they are handled), then operational alerts. While the integrations list is still
 * loading (`ready` false) the aggregator section shows nothing rather than a misleading "turn on" hint, and until the
 * first Zomato request settles (`loaded` false) it claims neither "no open orders" nor "nothing needs attention".
 */
export function AlertsPanel({ rows, truncated = false, operational, ready = true, loaded = true, zomatoEnabled, canManage, error, onOpenTables, onOpenMarketplace }: {
  rows: AlertRow[]; truncated?: boolean; operational: OperationalAlert[]; ready?: boolean; loaded?: boolean; zomatoEnabled: boolean; canManage: boolean;
  error: string; onOpenTables: () => void; onOpenMarketplace: () => void;
}) {
  const count = rows.length + operational.length;
  const settled = ready && (!zomatoEnabled || loaded);
  const marketplace = canManage && <button type="button" className="dash-link" onClick={onOpenMarketplace}>Open Marketplace</button>;
  return <section className="dash-panel dash-alerts" aria-label="Alerts">
    <header className="dash-panel-head dash-alerts-head">
      <h3><Icon name="alert" size={18} />Alerts</h3>
      {count > 0 && <span className="dash-badge" aria-label={`${alertBadge(count, truncated)} alerts`}>{alertBadge(count, truncated)}</span>}
    </header>
    {zomatoEnabled && rows.length > 0 && <ul className="dash-alert-list" aria-label="Open delivery orders">
      {rows.map((row) => <li key={`${row.channel}:${row.orderId}`}>
        <button type="button" className="dash-alert-row" onClick={onOpenTables} aria-label={`${channelName[row.channel]} order ${row.orderId}, ${statusText(row.status)}, ${reportMoney(row.amountPaise)}, ${row.statusText}`}>
          <span className={`dash-channel-tag ${row.channel}`}>{channelName[row.channel]}</span>
          <span className="dash-alert-main"><strong>#{row.orderId}</strong><small>{row.statusText}</small></span>
          <span className="dash-alert-side"><strong>{reportMoney(row.amountPaise)}</strong></span>
        </button>
      </li>)}
    </ul>}
    {zomatoEnabled && truncated && <p className="dash-alert-note">Showing the oldest {rows.length} open orders. <button type="button" className="dash-link" onClick={onOpenTables}>Open Tables</button></p>}
    {zomatoEnabled && loaded && !error && rows.length === 0 && <p className="dash-alert-note">No open Zomato orders.</p>}
    {zomatoEnabled && error && <p className="dash-alert-note dash-alert-error" role="status">{error}</p>}
    {ready && zomatoEnabled && <p className="dash-alert-note">Swiggy not connected. {marketplace}</p>}
    {ready && !zomatoEnabled && <p className="dash-alert-note">{canManage ? "Turn on" : "Ask an admin to turn on"} Zomato or Swiggy in the Marketplace. {marketplace}</p>}
    {operational.length > 0 && <ul className="dash-alert-list dash-operational" aria-label="Counter alerts">
      {operational.map((alert) => <li key={alert.key} className="dash-alert-op"><Icon name="bills" size={16} /><span>{alert.message}</span></li>)}
    </ul>}
    {count === 0 && settled && <p className="dash-alert-empty">Nothing needs attention right now.</p>}
  </section>;
}
