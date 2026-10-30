import { useMemo, useState, type FormEvent } from "react";
import type { CustomerDetail, InstallationSummary, OrderDetail, OrderInput, OrderKind, PortalSettingsData } from "../../../licensing-worker/src/portal/api-types";
import { buyerState, computeTotals, draftLines, formatPaise, parseRupees, PLAN_DEVICES, PLAN_NAMES } from "../../../licensing-worker/src/portal/shared";
import { MODULES } from "../../../../packages/domain/src/modules";
import { api, patch, post } from "../api";
import { date, money } from "../format";
import { Link, navigate, useLeaveGuard } from "../router";
import { Field, LoadError, PageHead, Tabs, useData, useRun } from "../ui";
import { counterName } from "./Counter";

const TERMS = [1, 3, 6, 12, 24, 36];
const rupees = (paise: number) => formatPaise(paise, "").replace(/\.00$/, "");

interface Form {
  kind: OrderKind; plan: "basic" | "pro"; termMonths: number; outlets: string; maxDevices: string; price: string; discount: string;
  modules: Record<string, boolean>; extras: Array<{ description: string; sac: string; quantity: string; price: string }>; installationIds: string[]; notes: string;
}

/** Drafting or editing an order for one customer, with the GST worked out as it will be invoiced. */
export function OrderEditor({ customerId, orderId, kind }: { customerId: string | null; orderId?: string; kind?: OrderKind }) {
  const existing = useData(() => orderId ? api<{ order: OrderDetail }>(`/orders/${orderId}`) : Promise.resolve(null), orderId ?? "new");
  const id = orderId ? existing.data?.order.customer.id ?? null : customerId;
  const customer = useData(() => id ? api<{ customer: CustomerDetail }>(`/customers/${id}`) : Promise.resolve(null), id ?? "none");
  const counters = useData(() => id ? api<{ installations: InstallationSummary[] }>(`/customers/${id}/installations`) : Promise.resolve(null), id ?? "none");
  const settings = useData(() => api<{ settings: PortalSettingsData }>("/settings"), "settings");
  const error = existing.error || customer.error || settings.error;
  if (!id && !orderId) return <><PageHead title="New order" /><p className="empty-block">Start a new order from the customer's page.</p></>;
  if (error) return <><PageHead title="New order" /><LoadError message={error} retry={() => { void customer.reload(); void settings.reload(); }} /></>;
  if (!customer.data || !settings.data || !counters.data || (orderId && !existing.data)) return <PageHead title={orderId ? "Edit order" : "New order"} sub="Loading…" />;
  return <EditorForm customer={customer.data.customer} settings={settings.data.settings} counters={counters.data.installations}
    order={existing.data?.order ?? null} initialKind={kind ?? "new"} />;
}

function EditorForm({ customer, settings, counters, order, initialKind }: {
  customer: CustomerDetail; settings: PortalSettingsData; counters: InstallationSummary[]; order: OrderDetail | null; initialKind: OrderKind;
}) {
  const priceFor = (plan: "basic" | "pro", months: number) => settings.prices.find((p) => p.plan === plan && p.termMonths === months)?.pricePaise;
  const [form, setForm] = useState<Form>(() => {
    if (order) {
      const licence = order.lines[0];
      return {
        kind: order.kind, plan: order.plan, termMonths: order.termMonths ?? 12, outlets: String(order.outlets || 1), maxDevices: String(order.maxDevices),
        price: rupees(licence?.unitPricePaise ?? 0), discount: rupees(licence?.discountPaise ?? 0), modules: order.modules,
        extras: order.lines.filter((l) => l.kind === "extra").map((l) => ({ description: l.description, sac: l.sac, quantity: String(l.quantity), price: rupees(l.unitPricePaise) })),
        installationIds: order.renewalTargets.map((t) => t.id), notes: order.notes ?? "",
      };
    }
    return { kind: initialKind, plan: "pro", termMonths: 12, outlets: "1", maxDevices: String(PLAN_DEVICES.pro), price: rupees(priceFor("pro", 12) ?? 0), discount: "0",
      modules: {}, extras: [], installationIds: [], notes: "" };
  });
  const [touched, setTouched] = useState(false);
  const { busy, run, status, setError } = useRun();
  const update = (change: Partial<Form>) => { setForm((f) => ({ ...f, ...change })); setTouched(true); };
  useLeaveGuard(() => !touched || busy || window.confirm("Leave without saving this order?"));
  const enrolled = counters.filter((c) => c.enrolled);

  const input = useMemo((): OrderInput | string => {
    const price = parseRupees(form.price || "0"), discount = parseRupees(form.discount || "0");
    if (price === null) return "Check the price per outlet.";
    if (discount === null) return "Check the discount.";
    const extras = [];
    for (const e of form.extras) {
      const unit = parseRupees(e.price || "0");
      if (unit === null || !e.description.trim() || !/^\d{4,8}$/.test(e.sac) || !(Number(e.quantity) >= 1)) return "Complete or remove the extra lines (description, SAC, quantity, price).";
      extras.push({ description: e.description.trim(), sac: e.sac, quantity: Number(e.quantity), unitPricePaise: unit });
    }
    return {
      customerId: customer.id, kind: form.kind, plan: form.plan, termMonths: form.termMonths, outlets: form.kind === "renewal" ? 0 : Number(form.outlets) || 0,
      maxDevices: Number(form.maxDevices) || PLAN_DEVICES[form.plan], modules: form.modules, pricePerOutletPaise: price, discountPaise: discount, extras,
      installationIds: form.kind === "renewal" ? form.installationIds : [], notes: form.notes,
    };
  }, [form, customer.id]);
  const buyer = buyerState(customer), seller = settings.seller.stateCode || null;
  const intra = buyer && seller ? buyer === seller : null;
  const lines = typeof input === "string" ? [] : draftLines(input, settings);
  const totals = computeTotals(lines, intra ?? true);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (typeof input === "string") { setError(input); return; }
    void run(async () => {
      const saved = order ? await patch<{ order: OrderDetail }>(`/orders/${order.id}`, input) : await post<{ order: OrderDetail }>("/orders", input);
      setTouched(false);
      navigate(`/orders/${saved.order.id}`, true);
    });
  };
  const setPlan = (plan: "basic" | "pro") => update({ plan, maxDevices: String(PLAN_DEVICES[plan]), price: rupees(priceFor(plan, form.termMonths) ?? (parseRupees(form.price) ?? 0)) });
  const setTerm = (termMonths: number) => update({ termMonths, price: rupees(priceFor(form.plan, termMonths) ?? (parseRupees(form.price) ?? 0)) });
  const trial = form.kind === "trial";

  return <form onSubmit={submit}>
    <PageHead back={<><Link to="/orders">Orders</Link> / <Link to={`/customers/${customer.id}`}>{customer.businessName}</Link></>}
      title={order ? `Edit ${order.code}` : trial ? "Start a trial" : "New order"}
      sub={trial ? `${settings.trialDays} days of ${PLAN_NAMES[form.plan]}, free. It's ready as soon as you save it.` : "Saved as a draft. Confirm it when the customer agrees to the price."}
      actions={<><button type="button" className="secondary" onClick={() => navigate(order ? `/orders/${order.id}` : `/customers/${customer.id}`)}>Cancel</button>
        <button className="primary" disabled={busy}>{trial ? "Start trial" : order ? "Save draft" : "Save draft"}</button></>} />
    {status}
    <div className="grid-main">
      <div className="stack">
        {!order && <Tabs label="Kind of order" value={form.kind} onChange={(kind) => update({ kind })} tabs={[
          { id: "new", label: "New outlets" }, { id: "renewal", label: `Renewal${enrolled.length ? "" : " (no counters yet)"}` }, { id: "trial", label: "Trial" },
        ]} />}
        <div className="form-grid">
          <Field label="Plan"><select value={form.plan} onChange={(e) => setPlan(e.target.value as "basic" | "pro")} disabled={busy}>
            <option value="pro">Pro: {PLAN_DEVICES.pro} devices, every module</option><option value="basic">Basic: {PLAN_DEVICES.basic} devices</option></select></Field>
          {!trial && <Field label="Term"><select value={form.termMonths} onChange={(e) => setTerm(Number(e.target.value))} disabled={busy}>
            {TERMS.map((m) => <option key={m} value={m}>{m === 1 ? "1 month" : m % 12 === 0 ? `${m / 12} year${m > 12 ? "s" : ""}` : `${m} months`}</option>)}</select></Field>}
          {form.kind !== "renewal" && <Field label="Outlets" hint="One counter (computer) per outlet activates with this order."><input type="number" min={1} max={500} required value={form.outlets} onChange={(e) => update({ outlets: e.target.value })} disabled={busy} /></Field>}
          {!trial && <Field label="Devices per outlet" hint={`The plan includes ${PLAN_DEVICES[form.plan]}.${settings.extraDevicePaise ? ` Each extra costs ${money(settings.extraDevicePaise)} per outlet.` : ""}`}>
            <input type="number" min={1} max={100} required value={form.maxDevices} onChange={(e) => update({ maxDevices: e.target.value })} disabled={busy} /></Field>}
          {!trial && <Field label="Price per outlet, before GST (₹)" hint={priceFor(form.plan, form.termMonths) !== undefined ? `List price ${money(priceFor(form.plan, form.termMonths)!)}` : "No list price for this plan and term"}>
            <input inputMode="decimal" required value={form.price} onChange={(e) => update({ price: e.target.value })} disabled={busy} /></Field>}
          {!trial && <Field label="Discount on the licence (₹)"><input inputMode="decimal" value={form.discount} onChange={(e) => update({ discount: e.target.value })} disabled={busy} /></Field>}
        </div>
        {form.kind === "renewal" && <section><h2 className="section-title" style={{ marginBottom: 8 }}>Counters to renew</h2>
          {enrolled.length === 0 ? <p className="empty-block">This customer has no activated counters to renew. Draft a new-outlets order instead.</p>
            : <ul className="stack" style={{ gap: 6 }}>{enrolled.map((c) => <li key={c.id}><label className="check">
              <input type="checkbox" checked={form.installationIds.includes(c.id)} disabled={busy}
                onChange={(e) => update({ installationIds: e.target.checked ? [...form.installationIds, c.id] : form.installationIds.filter((x) => x !== c.id) })} />
              {counterName(c)} <span className="muted">· {c.licence ? `ends ${date(c.licence.expiresAt)}` : "no licence"}</span></label></li>)}</ul>}
          <p className="muted small" style={{ marginTop: 8 }}>Each counter gets the term added to its current end date (or to the payment date if it has already ended).</p></section>}
        {!trial && <details><summary><strong>Modules</strong> <span className="muted">{Object.keys(form.modules).length ? `${Object.keys(form.modules).length} changed from the plan` : `as in the ${PLAN_NAMES[form.plan]} plan`}</span></summary>
          <table className="data" style={{ marginTop: 12 }}><thead><tr><th>Module</th><th>{PLAN_NAMES[form.plan]} plan</th><th>On this order</th></tr></thead><tbody>
            {MODULES.map(({ id, name, plans }) => { const inPlan = plans[form.plan]; const value = form.modules[id];
              return <tr key={id}><td>{name}</td><td>{inPlan ? "Included" : <span className="muted">Not included</span>}</td><td>
                <select aria-label={`${name} on this order`} value={value === undefined ? "" : String(value)} disabled={busy} style={{ width: 170 }}
                  onChange={(e) => { const next = { ...form.modules }; if (e.target.value === "") delete next[id]; else next[id] = e.target.value === "true"; update({ modules: next }); }}>
                  <option value="">Follow the plan</option><option value="true">Allow</option><option value="false">Block</option></select></td></tr>; })}
          </tbody></table></details>}
        {!trial && <section><div className="panel-head"><h2>Extra lines</h2><button type="button" className="ghost small" disabled={busy}
          onClick={() => update({ extras: [...form.extras, { description: "", sac: settings.invoice.sac, quantity: "1", price: "" }] })}>Add a line</button></div>
          {form.extras.length === 0 ? <p className="muted">Installation, training or anything else on the same invoice.</p> : form.extras.map((e, i) => {
            const set = (change: Partial<Form["extras"][number]>) => update({ extras: form.extras.map((x, j) => j === i ? { ...x, ...change } : x) });
            return <div key={i} className="form-grid" style={{ gridTemplateColumns: "minmax(0, 3fr) 110px 80px 130px auto", alignItems: "end", marginBottom: 8 }}>
              <Field label="Description"><input maxLength={200} value={e.description} onChange={(ev) => set({ description: ev.target.value })} disabled={busy} /></Field>
              <Field label="SAC / HSN"><input maxLength={8} inputMode="numeric" value={e.sac} onChange={(ev) => set({ sac: ev.target.value })} disabled={busy} /></Field>
              <Field label="Qty"><input type="number" min={1} value={e.quantity} onChange={(ev) => set({ quantity: ev.target.value })} disabled={busy} /></Field>
              <Field label="Price (₹)"><input inputMode="decimal" value={e.price} onChange={(ev) => set({ price: ev.target.value })} disabled={busy} /></Field>
              <button type="button" className="ghost" disabled={busy} onClick={() => update({ extras: form.extras.filter((_, j) => j !== i) })}>Remove</button>
            </div>;
          })}</section>}
        <Field label="Notes" hint="For the team; not printed on the invoice."><textarea rows={2} maxLength={2000} value={form.notes} onChange={(e) => update({ notes: e.target.value })} disabled={busy} /></Field>
      </div>
      <aside className="rail">
        <h2>{trial ? "Trial" : "Invoice preview"}</h2>
        {trial ? <p className="muted">Free for {settings.trialDays} days from the day the restaurant activates. No invoice.</p> : <>
          <table className="data"><tbody>
            {lines.map((l, i) => <tr key={i}><td>{l.description}<span className="sub">{l.quantity} × {money(l.unitPricePaise)}{l.discountPaise ? `, less ${money(l.discountPaise)}` : ""}</span></td>
              <td className="num">{money(totals.lines[i]!.taxablePaise)}</td></tr>)}
            <tr><td>Taxable value</td><td className="num">{money(totals.subtotalPaise)}</td></tr>
            {intra === false ? <tr><td>IGST {settings.invoice.gstRateBp / 100}%</td><td className="num">{money(totals.igstPaise)}</td></tr>
              : <><tr><td>CGST {settings.invoice.gstRateBp / 200}%</td><td className="num">{money(totals.cgstPaise)}</td></tr><tr><td>SGST {settings.invoice.gstRateBp / 200}%</td><td className="num">{money(totals.sgstPaise)}</td></tr></>}
            <tr><td><strong>Total</strong></td><td className="num"><strong>{money(totals.totalPaise)}</strong></td></tr>
          </tbody></table>
          {intra === null && <p className="notice warning" style={{ marginTop: 12 }}>{!seller ? "The seller's state isn't set in Settings yet." : "This customer has no state or GSTIN yet."} The preview assumes the same state; add it before confirming.</p>}
          {typeof input === "string" && <p className="notice warning" style={{ marginTop: 12 }}>{input}</p>}
        </>}
        <dl className="kv" style={{ marginTop: 16 }}><dt>Customer</dt><dd>{customer.businessName}</dd><dt>Customer ID</dt><dd className="mono">{customer.code}</dd></dl>
      </aside>
    </div>
  </form>;
}
