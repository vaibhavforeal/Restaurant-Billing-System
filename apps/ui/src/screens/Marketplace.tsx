import { useState } from "react";
import type { IntegrationInfo } from "@forkflow/domain/integrations";
import type { User } from "../api";
import { statusLabel } from "../integrations-model";
import { useIntegrations } from "../integrations";
import type { Page } from "../NavBar";
import { ZomatoSettingsDialog } from "./ZomatoConnection";
import "../marketplace.css";
import { FeatureControls } from "./FeatureControls";

const categoryLabel: Record<IntegrationInfo["category"], string> = { delivery: "Delivery", kitchen: "Kitchen" };

export function Marketplace({ user, onNavigate }: { user: User; onNavigate: (page: Page) => void }) {
  const { integrations, ready, refresh } = useIntegrations();
  const [zomatoSettings, setZomatoSettings] = useState(false);
  return <section className="screen marketplace-screen">
    <div className="page-header"><div><h2>Marketplace</h2><p>Connect ForkFlow to delivery platforms and add-ons</p></div></div>
    <p className="marketplace-note">Feature availability is managed by ForkFlow for this restaurant.</p>
    {!ready && <p role="status">Loading integrations…</p>}
    {ready && integrations.length === 0 && <div className="panel marketplace-empty" role="status"><p>Integrations could not be loaded.</p><button onClick={refresh}>Try again</button></div>}
    <ul className="marketplace-grid" aria-label="Integrations">
      {integrations.map((info) => {
        const label = statusLabel(info);
        return <li key={info.id} className="panel marketplace-card">
          <div className="marketplace-card-head">
            <div><h3>{info.name}</h3><span className="marketplace-tag">{categoryLabel[info.category]}</span></div>
            <span className={`marketplace-pill is-${info.status === "coming_soon" ? "soon" : !info.licensed ? "locked" : info.enabled ? "on" : "off"}`}>{label}</span>
          </div>
          <p className="marketplace-description">{info.description}</p>
          {!info.licensed && <p className="marketplace-plan-note">Upgrade to Pro to use the Kitchen Display</p>}
          <div className="marketplace-card-foot">
            {!info.licensed && user.role === "admin" ? <button onClick={() => onNavigate({ name: "settings", section: "plan" })}>View licence</button>
              : info.id === "zomato" && info.enabled && info.status === "available" && user.role === "admin" ? <button onClick={() => setZomatoSettings(true)}>Settings</button> : <span />}
            <span>{info.enabled && info.status === "available" ? "Available" : "Unavailable"}</span>
          </div>
        </li>;
      })}
    </ul>
    <FeatureControls user={user} />
    {user.role === "admin" && <ZomatoSettingsDialog open={zomatoSettings} canEdit onClose={() => setZomatoSettings(false)} />}
  </section>;
}

/** Shown in place of a page whose integration has been turned off in the Marketplace. */
export function IntegrationOff({ name, canManage, onOpenMarketplace }: { name: string; canManage: boolean; onOpenMarketplace: () => void }) {
  return <section className="screen marketplace-screen">
    <div className="panel marketplace-empty" role="status">
      <h3>{name} is turned off</h3>
      <p>{canManage ? `Turn ${name} on in the Marketplace to use it.` : `Ask an admin to turn ${name} on in the Marketplace.`}</p>
      {canManage && <button onClick={onOpenMarketplace}>Open Marketplace</button>}
    </div>
  </section>;
}
