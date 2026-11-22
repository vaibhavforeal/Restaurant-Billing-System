import { useEffect, useState, type FormEvent } from "react";
import { OfferRule, type Offer } from "@masalapos/domain/offers";
import { useIntegrations } from "../integrations";
import { apiFetch } from "../api";
import { uuid } from "../uuid";
import type { Product } from "../types";
import { paiseToRupees, rupeesToPaise } from "../money";
import "./offers.css";

type ListedOffer = Offer & { inWindow: boolean };
const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const kinds = { dine_in: "Dine-in", takeaway: "Takeaway", delivery: "Delivery" };
const initial: OfferRule = { name: "", state: "active", benefit: { kind: "percent", percent: 10 }, minimumPaise: 0,
  kinds: ["dine_in", "takeaway", "delivery"], weekdays: days.map((_,i) => i), firstDate: null, lastDate: null, startTime: null, endTime: null };

function benefitLabel(b: OfferRule["benefit"]) {
  if (b.kind === "bogo") return `Buy ${b.buy}, get ${b.get} free`;
  return b.kind === "fixed" ? `₹${paiseToRupees(b.paise)} off` : `${b.percent}% off`;
}

export function OffersPage() {
  const { integrations, ready, setEnabled, refresh } = useIntegrations();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const info = integrations.find(entry => entry.id === "offers");
  if (ready && info?.licensed && info.enabled) return <Offers />;
  async function enable() {
    setBusy(true);
    setError("");
    try { await setEnabled("offers", true); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not enable Offers"); }
    finally { setBusy(false); }
  }
  return <section className="screen offers-screen"><header className="offer-toolbar"><h2>Offers</h2></header>
    <div className="panel offer-empty">{!ready ? <p role="status">Loading offers…</p> : !info ? <p role="alert">Could not load Offers. <button onClick={refresh}>Retry</button></p>
      : !info.licensed ? <p>Your restaurant’s licence does not include Offers.</p> : <>
        <h3>Enable automatic offers</h3><p>Apply bill discounts and free-item deals at checkout.</p>
        <button className="primary" disabled={busy} onClick={() => void enable()}>Enable Offers</button></>}
      {error && <p role="alert">{error}</p>}
    </div></section>;
}

export function Offers({ close }: { close?: () => void }) {
  const [offers, setOffers] = useState<ListedOffer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [clientRef, setClientRef] = useState("");
  const [edit, setEdit] = useState<Offer | "new" | null>(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  async function reload() {
    setError("");
    try {
      const [rules, menu] = await Promise.all([apiFetch<{ offers: ListedOffer[] }>("/api/offers"), apiFetch<{ products: Product[] }>("/api/products")]);
      setOffers(rules.offers); setProducts(menu.products); setReady(true);
    } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { void reload(); }, []);
  async function save(rule: OfferRule, existing?: Offer) {
    setBusy(true); setError("");
    try {
      await apiFetch(existing ? `/api/offers/${existing.id}` : "/api/offers", {
        method: existing ? "PUT" : "POST", body: JSON.stringify(existing ? { revision: existing.revision, rule } : { ...rule, clientRef }),
      });
      setEdit(null); await reload();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  const [archived, setArchived] = useState(false);
  const archivedCount = offers.filter(o => o.state === "archived").length;
  const visible = offers.filter(o => (o.state === "archived") === archived);
  function create() {
    setArchived(false);
    setClientRef(uuid());
    setEdit("new");
  }
  return <section className="screen offers-screen">
    <header className="offer-toolbar">
      <h2>{edit === "new" ? "Create offer" : edit ? "Edit offer" : "Offers"}</h2>
      <div className="offers-actions">
        {close && !edit && <button onClick={close} disabled={busy}>Back to Marketplace</button>}
        {ready && !edit && <button className="primary" onClick={create} disabled={busy}>Create offer</button>}
      </div>
    </header>
    {error && <p role="alert">{error} <button disabled={busy} onClick={() => { setEdit(null); void reload(); }}>Reload offers</button></p>}
    {!ready && !error && <p role="status">Loading offers…</p>}
    {ready && (edit ? <OfferForm key={edit === "new" ? "new" : edit.id} rule={edit === "new" ? initial : edit} products={products} busy={busy}
      cancel={() => setEdit(null)} save={rule => save(rule, edit === "new" ? undefined : edit)}
      archive={edit === "new" ? undefined : () => save({ ...edit, state: "archived" }, edit)} /> : <>
      {archivedCount > 0 && <div className="offer-filters" role="group" aria-label="Offer list">
        <button aria-pressed={!archived} onClick={() => setArchived(false)}>Current</button>
        <button aria-pressed={archived} onClick={() => setArchived(true)}>Archived ({archivedCount})</button>
      </div>}
      {!visible.length && <div className="panel offer-empty"><h3>No current offers</h3><p>Create a bill discount or give guests a free menu item.</p></div>}
      {visible.length > 0 && <div className="panel offer-list">{visible.map(o => <article key={o.id} className="offer-row">
        <div><div className="offer-title"><h3>{o.name}</h3><span className={o.state === "active" && o.inWindow ? "offer-status live" : "offer-status"}>
          {o.state === "archived" ? "Archived" : o.state === "paused" ? "Paused" : o.inWindow ? "Active" : "Outside schedule"}</span></div>
          <strong>{benefitLabel(o.benefit)}</strong>{o.minimumPaise > 0 && <span> on bills from ₹{paiseToRupees(o.minimumPaise)}</span>}
          <p>{o.kinds.length === 3 ? "All order types" : o.kinds.map(k => kinds[k]).join(", ")} · {scheduleLabel(o)}</p>
        </div>
        {o.state !== "archived" && <div className="offers-actions"><button disabled={busy} onClick={() => setEdit(o)}>Edit</button>
          <button disabled={busy} onClick={() => void save({ ...o, state: o.state === "active" ? "paused" : "active" }, o)}>{o.state === "active" ? "Pause" : "Activate"}</button></div>}
      </article>)}</div>}
    </>)}
  </section>;
}

function scheduleLabel(rule: OfferRule) {
  const parts = [rule.weekdays.length === 7 ? "Every day" : rule.weekdays.map(d => days[d]).join(", ")];
  if (rule.startTime) parts.push(`${rule.startTime}–${rule.endTime}`);
  if (rule.firstDate) parts.push(`From ${rule.firstDate}`);
  if (rule.lastDate) parts.push(`Until ${rule.lastDate}`);
  return parts.join(" · ");
}

type Target = { productId: string; variantId: string | null };
type Choice = Target & { label: string };
const targetKey = (t: Target) => JSON.stringify([t.productId, t.variantId]);

function DishPicker({ label, choices, selected, change }: { label: string; choices: Choice[]; selected: Target[]; change: (items: Target[]) => void }) {
  const [query, setQuery] = useState("");
  const keys = new Set(selected.map(targetKey));
  const matches = choices.filter(c => c.label.toLowerCase().includes(query.trim().toLowerCase()));
  return <fieldset className="offer-picker"><legend>{label} ({selected.length})</legend>
    <input type="search" aria-label={`Search ${label.toLowerCase()}`} placeholder="Search dishes or variants" value={query} onChange={e => setQuery(e.target.value)} />
    <div className="offer-choices">{matches.map(c => <label key={targetKey(c)}><input type="checkbox" checked={keys.has(targetKey(c))}
      onChange={e => change(e.target.checked ? [...selected, { productId: c.productId, variantId: c.variantId }] : selected.filter(t => targetKey(t) !== targetKey(c)))} />{c.label}</label>)}
      {!matches.length && <p>{query ? "No matching dishes." : "No dishes available."}</p>}
    </div>
  </fieldset>;
}

function OfferForm({ rule, products, busy, cancel, save, archive }: { rule: OfferRule; products: Product[]; busy: boolean;
  cancel: () => void; save: (r: OfferRule) => Promise<void>; archive: (() => Promise<void>) | undefined }) {
  const b = rule.benefit;
  const [kind, setKind] = useState(b.kind);
  const [error, setError] = useState("");
  const [qualifying, setQualifying] = useState<Target[]>(b.kind === "bogo" ? b.qualifying : []);
  const [rewards, setRewards] = useState<Target[]>(b.kind === "bogo" ? b.rewards : []);
  const [showLimits, setShowLimits] = useState(rule.minimumPaise > 0 || rule.kinds.length < 3 || rule.weekdays.length < 7 || !!(rule.firstDate || rule.lastDate || rule.startTime));
  const choices = products.filter(p => !p.addonOnly).flatMap(p => [
    { productId: p.id, variantId: null, label: p.variants.length ? `${p.name} (all variants)` : p.name },
    ...p.variants.map(v => ({ productId: p.id, variantId: v.id, label: p.name + " · " + v.name })),
  ]);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const field = (key: string) => String(data.get(key) ?? "");
    const benefit = kind === "bogo" ? { kind, buy: Number(field("buy")), get: Number(field("get")), qualifying, rewards }
      : kind === "fixed" ? { kind, paise: rupeesToPaise(field("amount")) } : { kind, percent: Number(field("amount")) };
    if (kind === "bogo" && (!qualifying.length || !rewards.length)) { setError("Choose at least one qualifying dish and one free dish."); return; }
    if (!data.has("kinds") || !data.has("days")) { setShowLimits(true); setError("Choose at least one order type and one day."); return; }
    const parsed = OfferRule.safeParse({ name: field("name"), state: rule.state, benefit, minimumPaise: rupeesToPaise(field("minimum") || "0"),
      kinds: data.getAll("kinds"), weekdays: data.getAll("days").map(Number), firstDate: field("first") || null, lastDate: field("last") || null,
      startTime: field("start") || null, endTime: field("end") || null });
    if (!parsed.success) { setShowLimits(true); setError(parsed.error.issues[0]?.message ?? "Check the offer details."); return; }
    setError(""); void save(parsed.data);
  }
  return <form className="panel offer-form" onSubmit={submit} onInvalidCapture={() => setShowLimits(true)}>
    <fieldset disabled={busy} className="offer-fields">
      <label className="offer-field">Offer name<input autoFocus name="name" required maxLength={80} placeholder="e.g. Weekday lunch" defaultValue={rule.name} /></label>
      <fieldset><legend>Offer type</legend><div className="offer-types">{(["percent", "fixed", "bogo"] as const).map(k =>
        <label key={k}><input type="radio" name="benefit" value={k} checked={kind === k} onChange={() => setKind(k)} />
          {k === "percent" ? "Percentage off" : k === "fixed" ? "Amount off" : "Buy X, get Y free"}</label>)}</div></fieldset>
      {kind === "bogo" ? <div className="offer-pair">{(["buy","get"] as const).map(side => <div className="offer-side" key={side}>
        <label className="offer-field">{side === "buy" ? "Buy quantity" : "Free quantity"}<input type="number" name={side} required min={1} max={999} defaultValue={b.kind === "bogo" ? b[side] : 1} /></label>
        <DishPicker label={side === "buy" ? "Qualifying dishes" : "Free dishes"} choices={choices} selected={side === "buy" ? qualifying : rewards} change={side === "buy" ? setQualifying : setRewards} />
      </div>)}</div> : <label className="offer-field">Discount {kind === "fixed" ? "(₹)" : "(%)"}
        <input key={kind} type="number" name="amount" required min={kind === "fixed" ? 0.01 : 1} max={kind === "percent" ? 100 : 10000000} step={kind === "fixed" ? "0.01" : "1"}
          defaultValue={kind !== b.kind ? "" : b.kind === "percent" ? b.percent : b.kind === "fixed" ? paiseToRupees(b.paise) : ""} /></label>}
      <details className="offer-limits" open={showLimits} onToggle={e => setShowLimits(e.currentTarget.open)}>
        <summary>Limits &amp; schedule</summary>
        <div className="offer-fields">
          <label className="offer-field">Minimum bill (₹)<input type="number" min={0} max={10000000} step="0.01" name="minimum" defaultValue={paiseToRupees(rule.minimumPaise)} /></label>
          <fieldset><legend>Order types</legend><div className="offer-checks">{initial.kinds.map(k => <label key={k}><input type="checkbox" name="kinds" value={k} defaultChecked={rule.kinds.includes(k)} />{kinds[k]}</label>)}</div></fieldset>
          <fieldset><legend>Days</legend><div className="offer-checks">{days.map((d,i) => <label key={d}><input type="checkbox" name="days" value={i} defaultChecked={rule.weekdays.includes(i)} />{d}</label>)}</div></fieldset>
          <div className="offer-pair"><label className="offer-field">First date<input type="date" name="first" defaultValue={rule.firstDate ?? ""} /></label><label className="offer-field">Last date<input type="date" name="last" defaultValue={rule.lastDate ?? ""} /></label>
          <label className="offer-field">Starts at<input type="time" name="start" defaultValue={rule.startTime ?? ""} /></label><label className="offer-field">Ends at<input type="time" name="end" defaultValue={rule.endTime ?? ""} /></label></div>
        </div>
      </details>
      {error && <p role="alert">{error}</p>}
      <footer className="offers-actions">{archive && <button type="button" className="offer-archive" onClick={() => { if (window.confirm(`Archive “${rule.name}”? It will stop applying to new bills.`)) void archive(); }}>Archive offer</button>}
        <button type="button" onClick={cancel}>Cancel</button><button type="submit" className="primary">{busy ? "Saving…" : "Save offer"}</button></footer>
    </fieldset>
  </form>;
}
