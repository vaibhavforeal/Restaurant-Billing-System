import { useEffect, useState, type FormEvent } from "react";
import { OfferRule, type Offer } from "@masalapos/domain/offers";
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

export function Offers({ close }: { close: () => void }) {
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
  return <section className="screen offers-screen">
    <header className="page-header"><h2>Offers</h2><button disabled={busy} onClick={close}>Back to Marketplace</button></header>
    {error && <p role="alert">{error} <button onClick={() => { setEdit(null); void reload(); }}>Reload offers</button></p>}
    {!ready && !error && <p role="status">Loading offers…</p>}
    {ready && (edit ? <OfferForm key={edit === "new" ? "new" : edit.id} rule={edit === "new" ? initial : edit} products={products} busy={busy}
      cancel={() => setEdit(null)} save={rule => save(rule, edit === "new" ? undefined : edit)} /> : <>
      <button disabled={busy} className="primary" onClick={() => { setClientRef(uuid()); setEdit("new"); }}>Create offer</button>
      {!offers.length && <p>No offers yet.</p>}
      {offers.map(o => <article key={o.id} className="panel"><h3>{o.name}</h3><p>{benefitLabel(o.benefit)} · {o.kinds.map(k => kinds[k]).join(", ")} · {o.state === "active" ? (o.inWindow ? "Active now" : "Outside schedule") : o.state}</p>
        <p>{o.weekdays.map(d => days[d]).join(", ")} · {o.startTime ? `${o.startTime}–${o.endTime}` : "All day"}{(o.firstDate || o.lastDate) && ` · ${o.firstDate ?? "Any date"} – ${o.lastDate ?? "Ongoing"}`}{o.minimumPaise > 0 && ` · Minimum ₹${paiseToRupees(o.minimumPaise)}`}</p>
        {o.state !== "archived" && <div className="offers-actions"><button disabled={busy} onClick={() => setEdit(o)}>Edit</button>
          <button disabled={busy} onClick={() => void save({ ...o, state: o.state === "active" ? "paused" : "active" }, o)}>{o.state === "active" ? "Pause" : "Activate"}</button>
          <button disabled={busy} onClick={() => void save({ ...o, state: "archived" }, o)}>Archive</button></div>}
      </article>)}</>)}
  </section>;
}

function OfferForm({ rule, products, busy, cancel, save }: { rule: OfferRule; products: Product[]; busy: boolean; cancel: () => void; save: (r: OfferRule) => Promise<void> }) {
  const [kind, setKind] = useState(rule.benefit.kind);
  const [error, setError] = useState("");
  const b = rule.benefit;
  const choices = products.filter(p => !p.addonOnly).flatMap(p =>
    [{ value: JSON.stringify({ productId: p.id, variantId: null }), label: p.name },
      ...p.variants.map(v => ({ value: JSON.stringify({ productId: p.id, variantId: v.id }), label: p.name + " · " + v.name }))]);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const field = (key: string) => String(data.get(key) ?? "");
    const targets = (key: string) => data.getAll(key).map(v => JSON.parse(String(v)));
    const benefit = kind === "bogo" ? { kind, buy: Number(field("buy")), get: Number(field("get")), qualifying: targets("qualifying"), rewards: targets("rewards") }
      : kind === "fixed" ? { kind, paise: rupeesToPaise(field("amount")) } : { kind, percent: Number(field("amount")) };
    const parsed = OfferRule.safeParse({ name: field("name"), state: rule.state, benefit, minimumPaise: rupeesToPaise(field("minimum")),
      kinds: data.getAll("kinds"), weekdays: data.getAll("days").map(Number), firstDate: field("first") || null, lastDate: field("last") || null,
      startTime: field("start") || null, endTime: field("end") || null });
    if (!parsed.success) { setError(parsed.error.issues.map(i => [i.path.join(" "), i.message].filter(Boolean).join(" — ")).join(". ")); return; }
    setError(""); void save(parsed.data);
  }
  return <form className="panel" onSubmit={submit}><fieldset disabled={busy}><legend>{rule.name ? "Edit offer" : "Create offer"}</legend>
    <label>Name<input name="name" required maxLength={80} defaultValue={rule.name} /></label>
    <label>Benefit<select value={kind} onChange={e => setKind(e.target.value as typeof kind)}><option value="percent">Percentage off bill</option><option value="fixed">Amount off bill</option><option value="bogo">Buy X, get Y free</option></select></label>
    {kind === "bogo" ? <>{(["qualifying", "rewards"] as const).map((side,i) => <div key={side}>
      <label>{i ? "Free quantity" : "Buy quantity"}<input type="number" name={i ? "get" : "buy"} required min={1} max={999} defaultValue={b.kind === "bogo" ? (i ? b.get : b.buy) : 1} /></label>
      <label>{i ? "Reward dishes or variants" : "Qualifying dishes or variants"}<select name={side} multiple required defaultValue={b.kind === "bogo" ? b[side].map(t => JSON.stringify(t)) : []}>
        {choices.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}</select></label></div>)}</>
      : <label>{kind === "fixed" ? "Discount (₹)" : "Discount (%)"}<input key={kind} type="number" name="amount" required min={kind === "fixed" ? 0.01 : 1} max={kind === "percent" ? 100 : undefined} step={kind === "fixed" ? "0.01" : "1"} defaultValue={kind !== b.kind ? "" : b.kind === "percent" ? b.percent : b.kind === "fixed" ? paiseToRupees(b.paise) : ""} /></label>}
    <label>Minimum bill (₹)<input type="number" required min={0} step="0.01" name="minimum" defaultValue={paiseToRupees(rule.minimumPaise)} /></label>
    <fieldset><legend>Order types</legend>{initial.kinds.map(k => <label key={k}><input type="checkbox" name="kinds" value={k} defaultChecked={rule.kinds.includes(k)} />{kinds[k]}</label>)}</fieldset>
    <fieldset><legend>Days</legend>{days.map((d,i) => <label key={d}><input type="checkbox" name="days" value={i} defaultChecked={rule.weekdays.includes(i)} />{d}</label>)}</fieldset>
    <label>First date<input type="date" name="first" defaultValue={rule.firstDate ?? ""} /></label><label>Last date<input type="date" name="last" defaultValue={rule.lastDate ?? ""} /></label>
    <label>Starts at<input type="time" name="start" defaultValue={rule.startTime ?? ""} /></label><label>Ends at<input type="time" name="end" defaultValue={rule.endTime ?? ""} /></label>
    {error && <p role="alert">{error}</p>}
    <div className="offers-actions"><button type="submit" className="primary">Save offer</button><button type="button" onClick={cancel}>Cancel</button></div>
  </fieldset></form>;
}
