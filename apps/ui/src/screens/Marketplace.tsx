import { useRef, useState } from "react";
import type { IntegrationInfo } from "@masalapos/domain/integrations";
import type { User } from "../api";
import { canToggle, statusLabel } from "../integrations-model";
import { useIntegrations } from "../integrations";
import { useModules } from "../modules";
import type { ModuleGroup, ModuleInfo } from "@masalapos/domain/modules";
import type { Page } from "../NavBar";
import { ZomatoSettingsDialog } from "./ZomatoConnection";
import "../marketplace.css";
import { userCan } from "../permissions";

const categoryLabel: Record<IntegrationInfo["category"], string> = { delivery: "Delivery", kitchen: "Kitchen", customers: "Customers" };

export function Marketplace({ user, onNavigate }: { user: User; onNavigate: (page: Page) => void }) {
  const { integrations, ready, setEnabled, refresh } = useIntegrations();
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [zomatoSettings, setZomatoSettings] = useState(false);
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
    <div className="page-header"><div><h2>Marketplace</h2><p>Add-ons and modules for this restaurant</p></div></div>
    <p className="marketplace-note">MasalaPOS decides which add-ons and modules this restaurant can use. {userCan(user, "integrations.configure") ? "You can turn an included one off here and back on later." : "Only an admin can turn them on or off."}</p>
    <h3 className="marketplace-section">Add-ons</h3>
    {!ready && <p role="status">Loading integrations…</p>}
    {ready && integrations.length === 0 && <div className="panel marketplace-empty" role="status"><p>Integrations could not be loaded.</p><button onClick={refresh}>Try again</button></div>}
    <ul className="marketplace-grid" aria-label="Integrations">
      {integrations.map((info) => {
        const label = statusLabel(info);
        const interactive = canToggle(info, userCan(user, "integrations.configure"));
        const busy = pending.has(info.id);
        const error = errors[info.id];
        return <li key={info.id} className="panel marketplace-card">
          <div className="marketplace-card-head">
            <div><h3>{info.name}</h3><span className="marketplace-tag">{categoryLabel[info.category]}</span></div>
            <span className={`marketplace-pill is-${info.status === "coming_soon" ? "soon" : !info.licensed ? "locked" : info.enabled ? "on" : "off"}`}>{label}</span>
          </div>
          <p className="marketplace-description">{info.description}</p>
          {!info.licensed && info.status === "available" && <p className="marketplace-plan-note">Not included for this restaurant. Contact MasalaPOS to add it.</p>}
          {error && <p role="alert" className="marketplace-error">{error}</p>}
          <div className="marketplace-card-foot">
            {!info.licensed && info.status === "available" && userCan(user, "settings.manage") ? <button onClick={() => onNavigate({ name: "settings", section: "plan" })}>View licence</button>
              : info.id === "zomato" && info.enabled && info.status === "available" && userCan(user, "zomato.configure") ? <button onClick={() => setZomatoSettings(true)}>Settings</button> : <span />}
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
    <ModuleSection group="service" title="Service modules" user={user} />
    <ModuleSection group="backoffice" title="Back-office modules" user={user} />
    {userCan(user, "zomato.configure") && <ZomatoSettingsDialog open={zomatoSettings} canEdit onClose={() => setZomatoSettings(false)} />}
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

/** One group of modules with their switches: an admin can turn an included module off and back on. */
function ModuleSection({ group, title, user }: { group: ModuleGroup; title: string; user: User }) {
  const { modules, ready, setEnabled } = useModules();
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const inFlight = useRef(new Set<string>());
  const list = modules.filter((m) => m.group === group);
  const nameOf = (id: string) => modules.find((m) => m.id === id)?.name ?? id;

  async function toggle(m: ModuleInfo) {
    if (inFlight.current.has(m.id)) return;
    inFlight.current.add(m.id);
    setPending(new Set(inFlight.current));
    setErrors(({ [m.id]: _cleared, ...rest }) => rest);
    try { await setEnabled(m.id, !m.enabled); }
    catch (error) { setErrors((current) => ({ ...current, [m.id]: error instanceof Error ? error.message : "Could not update the module" })); }
    finally { inFlight.current.delete(m.id); setPending(new Set(inFlight.current)); }
  }

  if (!ready) return null;
  return <>
    <h3 className="marketplace-section">{title}</h3>
    <ul className="marketplace-grid" aria-label={title}>
      {list.map((m) => {
        const interactive = userCan(user, "integrations.configure") && (m.enabled || m.allowed);
        const busy = pending.has(m.id);
        return <li key={m.id} className="panel marketplace-card">
          <div className="marketplace-card-head">
            <div><h3>{m.name}</h3>{m.dependsOn.length > 0 && <span className="marketplace-tag">Needs {m.dependsOn.map(nameOf).join(", ")}</span>}</div>
            <span className={`marketplace-pill is-${!m.allowed ? "locked" : m.active ? "on" : "off"}`}>{!m.allowed ? "Not included" : m.active ? "On" : m.enabled ? "Waiting" : "Off"}</span>
          </div>
          <p className="marketplace-description">{m.description}</p>
          {!m.allowed && <p className="marketplace-plan-note">Not included for this restaurant. Contact MasalaPOS to add it.</p>}
          {m.allowed && m.enabled && !m.active && m.reason && <p className="marketplace-plan-note">{m.reason}.</p>}
          {errors[m.id] && <p role="alert" className="marketplace-error">{errors[m.id]}</p>}
          <div className="marketplace-card-foot">
            <span />
            <button type="button" role="switch" className="marketplace-switch" aria-checked={m.enabled && m.allowed} aria-label={`${m.name} module`}
              disabled={!interactive} aria-disabled={busy || undefined} aria-busy={busy || undefined} onClick={() => void toggle(m)}><span aria-hidden="true" /></button>
          </div>
        </li>;
      })}
    </ul>
  </>;
}

/** Shown in place of a page whose module is not available: why, and what to do about it. */
export function ModuleOff({ module, canManage, onOpenMarketplace }: { module: ModuleInfo | null; canManage: boolean; onOpenMarketplace: () => void }) {
  const name = module?.name ?? "This module";
  const notIncluded = module ? !module.allowed : true;
  return <section className="screen marketplace-screen">
    <div className="panel marketplace-empty" role="status">
      <h3>{name} is not available</h3>
      <p>{notIncluded ? `${name} is not included for this restaurant. Contact MasalaPOS to add it.`
        : module?.enabled ? `${module.reason ?? "It needs another module"}. Turn that on in the Marketplace.`
        : canManage ? `Turn ${name} on in the Marketplace to use it.` : `Ask an admin to turn ${name} on in the Marketplace.`}</p>
      {canManage && !notIncluded && <button onClick={onOpenMarketplace}>Open Marketplace</button>}
    </div>
  </section>;
}
