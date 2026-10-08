import { useRef, useState } from "react";
import type { IntegrationInfo } from "@forkflow/domain/integrations";
import type { User } from "../api";
import { canToggle, statusLabel } from "../integrations-model";
import { useIntegrations } from "../integrations";
import type { Page } from "../NavBar";
import "../marketplace.css";

const categoryLabel: Record<IntegrationInfo["category"], string> = { delivery: "Delivery", kitchen: "Kitchen" };

export function Marketplace({ user, onNavigate }: { user: User; onNavigate: (page: Page) => void }) {
  const { integrations, ready, setEnabled, refresh } = useIntegrations();
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const inFlight = useRef(new Set<string>());

  async function toggle(info: IntegrationInfo) {
    if (inFlight.current.has(info.id)) return; // a second click before React re-renders must not send a second request
    inFlight.current.add(info.id);
    setPending(new Set(inFlight.current));
    setErrors(({ [info.id]: _cleared, ...rest }) => rest);
    try {
      await setEnabled(info.id, !info.enabled);
    } catch (error) {
      setErrors((current) => ({ ...current, [info.id]: error instanceof Error ? error.message : "Could not update the integration" }));
    } finally {
      inFlight.current.delete(info.id);
      setPending(new Set(inFlight.current));
    }
  }

  return <section className="screen marketplace-screen">
    <div className="page-header"><div><h2>Marketplace</h2><p>Connect ForkFlow to delivery platforms and add-ons</p></div></div>
    {user.role !== "admin" && <p className="marketplace-note">Only an admin can turn integrations on or off.</p>}
    {!ready && <p role="status">Loading integrations…</p>}
    {ready && integrations.length === 0 && <div className="panel marketplace-empty" role="status"><p>Integrations could not be loaded.</p><button onClick={refresh}>Try again</button></div>}
    <ul className="marketplace-grid" aria-label="Integrations">
      {integrations.map((info) => {
        const label = statusLabel(info);
        const interactive = canToggle(info, user.role);
        const busy = pending.has(info.id);
        const error = errors[info.id];
        return <li key={info.id} className="panel marketplace-card">
          <div className="marketplace-card-head">
            <div><h3>{info.name}</h3><span className="marketplace-tag">{categoryLabel[info.category]}</span></div>
            <span className={`marketplace-pill is-${info.status === "coming_soon" ? "soon" : !info.licensed ? "locked" : info.enabled ? "on" : "off"}`}>{label}</span>
          </div>
          <p className="marketplace-description">{info.description}</p>
          {!info.licensed && <p className="marketplace-plan-note">Upgrade to Pro to use the Kitchen Display</p>}
          {error && <p role="alert" className="marketplace-error">{error}</p>}
          <div className="marketplace-card-foot">
            {!info.licensed && user.role === "admin" ? <button onClick={() => onNavigate({ name: "settings", section: "plan" })}>View licence</button>
              : info.enabled && info.status === "available" && info.setupPage ? <button onClick={() => onNavigate({ name: info.setupPage! })}>Set up</button> : <span />}
            <button
              type="button" role="switch" className="marketplace-switch"
              aria-checked={info.status === "available" && info.enabled}
              aria-label={`${info.name} integration`}
              // While saving, aria-disabled (not disabled) keeps keyboard focus on the switch; toggle() ignores the click.
              disabled={!interactive} aria-disabled={busy || undefined} aria-busy={busy || undefined}
              onClick={() => void toggle(info)}
            ><span aria-hidden="true" /></button>
          </div>
        </li>;
      })}
    </ul>
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
