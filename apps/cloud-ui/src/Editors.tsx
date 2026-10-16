import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api, dateTime, message, money } from "./api";
import type { Command, MirrorRecord, Records } from "./api";
import { catalogCommand, policyValues, rowBool, rowText, settingsCommand } from "./commands";
import type { CatalogForm, CommandInput } from "./commands";
import { Empty, Field, Loading, Notice, Title, useResource } from "./shared";

type Props = { outletId: string; refresh: number; canEdit: boolean };
function useRecords(outletId: string, table: string, refresh: number) {
  const path = `/outlets/${outletId}/records?table=${table}&limit=500`;
  const [state, setState] = useState<{ path: string; data: Records | null; loading: boolean; error: string }>({ path, data: null, loading: true, error: "" });
  useEffect(() => {
    let active = true;
    setState({ path, data: null, loading: true, error: "" });
    void (async () => {
      let cursor: string | null = null, result: Records | null = null;
      const records: MirrorRecord[] = [], seen = new Set<string>();
      do {
        result = await api.request<Records>(path + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""));
        if (!active) return;
        records.push(...result.records); cursor = result.nextCursor ?? null;
        if (cursor && seen.has(cursor)) throw new Error("The next page could not be loaded. Refresh to try again.");
        if (cursor) seen.add(cursor);
      } while (cursor);
      if (active && result) setState({ path, data: { ...result, records }, loading: false, error: "" });
    })().catch(caught => { if (active) setState({ path, data: null, loading: false, error: message(caught) }); });
    return () => { active = false; };
  }, [path, refresh]);
  return state.path === path ? state : { path, data: null, loading: true, error: "" };
}
function useCommand(outletId: string) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [saved, setSaved] = useState<Command | null>(null);
  async function send(build: () => CommandInput) {
    setBusy(true); setError("");
    try { const command = build(); const result = await api.post<{ command: Command }>(`/outlets/${outletId}/commands`, command); setSaved(result.command); }
    catch (caught) { setError(message(caught)); }
    finally { setBusy(false); }
  }
  return { busy, error, saved, send };
}
function CommandNotice({ saved, error }: { saved: Command | null; error: string }) { return <Notice error={error}>{saved && <>Change sent. Status: <strong>{saved.status}</strong>. The outlet validates it before applying. Follow progress in Change history.</>}</Notice>; }
function EditorFootnote({ record }: { record: MirrorRecord }) { return <p className="muted small">Based on uploaded revision {record.revision}. If this record changed at the outlet, your change is marked as a conflict for review.</p>; }

export function Catalog(props: Props) {
  const [table, setTable] = useState("products"), [selected, setSelected] = useState<string | null>(null), [search, setSearch] = useState("");
  const result = useRecords(props.outletId, table, props.refresh), records = result.data?.records ?? [], record = records.find(item => String(item.key.id) === selected);
  return <section className="panel"><Title title="Menu & prices" description="Edit uploaded menu items. Changes remain pending until the outlet accepts them." /><div className="toolbar"><div className="tabs" role="group" aria-label="Catalog type">{[["products", "Products"], ["categories", "Categories"], ["variants", "Variants"]].map(([value, label]) => <button key={value} className={value === table ? "active" : ""} onClick={() => { setTable(value!); setSelected(null); }}>{label}</button>)}</div><Field label="Search menu"><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search by name" /></Field></div><Loading {...result} />{result.data && <><p className="muted small">{records.length} uploaded records · Last contact {dateTime(result.data.lastSeenAt)}</p><div className="catalog-layout"><div className="record-list">{records.filter(item => rowText(item.row, "name").toLowerCase().includes(search.toLowerCase())).map(item => <button key={String(item.key.id)} className={String(item.key.id) === selected ? "chosen" : ""} onClick={() => setSelected(String(item.key.id))}><span><strong>{rowText(item.row, "name")}</strong><small>{rowBool(item.row, "is_active") ? "Active" : "Inactive"}</small></span>{table !== "categories" && <span>{money(item.row.price_paise as number)}</span>}</button>)}{!records.length && <Empty>No records uploaded yet.</Empty>}</div>{record ? <CatalogEditor key={`${table}-${record.key.id}-${record.revision}`} {...props} table={table} record={record} /> : <Empty>Select a {table === "categories" ? "category" : table === "variants" ? "variant" : "product"} to edit.</Empty>}</div></>}</section>;
}
function CatalogEditor({ table, record, outletId, canEdit }: Props & { table: string; record: MirrorRecord }) {
  const [form, setForm] = useState<CatalogForm>({ name: rowText(record.row, "name"), price: (Number(record.row.price_paise ?? 0) / 100).toFixed(2), active: rowBool(record.row, "is_active"), description: rowText(record.row, "description"), veg: rowBool(record.row, "is_veg"), soldOut: rowBool(record.row, "is_sold_out") });
  const command = useCommand(outletId), change = <K extends keyof CatalogForm>(key: K, value: CatalogForm[K]) => setForm(old => ({ ...old, [key]: value }));
  return <form className="editor" onSubmit={event => { event.preventDefault(); void command.send(() => catalogCommand(table, record, form)); }}><h3>Edit {rowText(record.row, "name")}</h3><CommandNotice {...command} /><fieldset disabled={!canEdit || command.busy || !!command.saved}><Field label="Name"><input required value={form.name} onChange={event => change("name", event.target.value)} /></Field>{table !== "categories" && <Field label="Base price (₹)"><input required inputMode="decimal" pattern="[0-9]+([.][0-9]{1,2})?" value={form.price} onChange={event => change("price", event.target.value)} /></Field>}{table === "products" && <><Field label="Description"><textarea maxLength={500} value={form.description} onChange={event => change("description", event.target.value)} /></Field><label className="check"><input type="checkbox" checked={form.veg} onChange={event => change("veg", event.target.checked)} />Vegetarian</label><label className="check"><input type="checkbox" checked={form.soldOut} onChange={event => change("soldOut", event.target.checked)} />Sold out</label></>}<label className="check"><input type="checkbox" checked={form.active} onChange={event => change("active", event.target.checked)} />Active on the menu</label><button className="primary">{command.busy ? "Sending…" : command.saved ? "Change sent" : "Send change to outlet"}</button></fieldset><EditorFootnote record={record} /></form>;
}
const settingsFields = [["restaurantName", "restaurant_name", "Restaurant name"], ["address", "address", "Address"], ["gstin", "gstin", "GSTIN"], ["fssai", "fssai", "FSSAI number"], ["receiptFooter", "receipt_footer", "Receipt footer"], ["upiId", "upi_id", "UPI ID"]] as const;
export function BusinessSettings(props: Props) {
  const result = useRecords(props.outletId, "settings", props.refresh), record = result.data?.records[0];
  return <section className="panel"><Title title="Business settings" description="Update receipt details and payment identity using the latest uploaded settings." /><Loading {...result} />{record && <SettingsEditor key={record.revision} {...props} record={record} />}{!record && !result.loading && !result.error && <Empty>Connect the outlet and wait for its first settings upload.</Empty>}</section>;
}
function SettingsEditor({ record, outletId, canEdit }: Props & { record: MirrorRecord }) {
  const [form, setForm] = useState<Record<string, string>>(() => Object.fromEntries(settingsFields.map(([name, column]) => [name, rowText(record.row, column)]))), command = useCommand(outletId);
  return <form className="editor wide" onSubmit={event => { event.preventDefault(); void command.send(() => settingsCommand(record, form)); }}><CommandNotice {...command} /><fieldset disabled={!canEdit || command.busy || !!command.saved}><div className="form-grid">{settingsFields.map(([name, , label]) => <Field key={name} label={label}><input required={name === "restaurantName"} maxLength={name === "gstin" ? 15 : name === "fssai" ? 14 : 500} value={form[name]} onChange={event => setForm(old => ({ ...old, [name]: event.target.value }))} /></Field>)}</div><p className="muted small">Tax mode, default GST rate and receipt layout retain the outlet’s uploaded values.</p><button className="primary">{command.busy ? "Sending…" : command.saved ? "Change sent" : "Send settings to outlet"}</button></fieldset><EditorFootnote record={record} /></form>;
}
const featureOptions = [["takeaway", "Takeaway"], ["reservations", "Reservations"], ["inventory", "Inventory"], ["recipes", "Recipes"], ["costing", "Dish costing"], ["qrOrdering", "Guest ordering"], ["guestServices", "Guest assistance"], ["dashboard", "Sales dashboard"], ["reports", "Reports & analytics"], ["zomato", "Zomato"], ["swiggy", "Swiggy"], ["kds", "Kitchen Display"]] as const;
export function Features(props: Props) {
  const result = useRecords(props.outletId, "cloud_feature_policy", props.refresh), record = result.data?.records[0];
  return <section className="panel"><Title title="Feature controls" description="Choose outlet capabilities. Licensing and dependencies are checked by the outlet before a change is applied." /><Notice>Billing, payments, administration and recovery always remain available.</Notice><Loading {...result} />{record && <FeatureEditor key={record.revision} {...props} record={record} />}{!record && !result.loading && !result.error && <Empty>Feature policy has not been uploaded yet. Connect the outlet first.</Empty>}</section>;
}
function FeatureEditor({ record, outletId, canEdit }: Props & { record: MirrorRecord }) {
  const [enabled, setEnabled] = useState(() => policyValues(record, "enabled")), command = useCommand(outletId);
  return <form onSubmit={event => { event.preventDefault(); void command.send(() => ({ kind: "features.update", targetId: "policy", expectedRevision: record.revision, payload: { enabled } })); }}><CommandNotice {...command} /><fieldset disabled={!canEdit || command.busy || !!command.saved}><div className="toggle-grid">{featureOptions.map(([id, label]) => <label key={id} className="toggle-row"><span><strong>{label}</strong><small>{["zomato", "swiggy", "kds"].includes(id) ? "Requires an available integration and entitlement" : "Outlet capability"}</small></span><input type="checkbox" checked={enabled[id] ?? !["zomato", "swiggy", "kds"].includes(id)} onChange={event => setEnabled(old => ({ ...old, [id]: event.target.checked }))} /></label>)}</div><button className="primary">{command.busy ? "Sending…" : command.saved ? "Change sent" : "Send feature policy"}</button></fieldset><EditorFootnote record={record} /></form>;
}
const permissions = [
  ["categories", "Categories", "read,create,update,delete"], ["products", "Products", "read,create,update,delete"], ["variants", "Product variants", "read,create,update,delete"], ["tables", "Tables", "read,create,update,delete"], ["reservations", "Reservations", "read,create,update,delete"], ["orders", "Orders", "read,create,update,delete"], ["kots", "Kitchen tickets", "read,create,update"], ["bills", "Bills & payments", "read,create,update,delete"], ["stock", "Stock", "read,create,update,delete"], ["recipes", "Recipes", "read,update"], ["costs", "Ingredient costs", "read,create"], ["users", "Staff accounts", "read,create,update,delete"], ["settings", "Restaurant settings", "read,update"], ["reports", "Reports", "read"], ["printers", "Printers & stations", "read,create,update,delete"], ["integrations", "Integrations", "read,update"],
] as const;
export function Staff(props: Props) {
  const roster = useRecords(props.outletId, "staff_roster", props.refresh), policies = useRecords(props.outletId, "cloud_staff_policy", props.refresh), [selected, setSelected] = useState("");
  const staff = roster.data?.records.find(item => String(item.key.id) === selected), policy = policies.data?.records.find(item => String(item.key.id) === selected);
  return <section className="panel"><Title title="Staff permissions" description="Control explicit permissions for outlet staff. Their PINs stay at the outlet." /><Loading {...roster} /><Loading {...policies} />{roster.data && policies.data && <><Field label="Staff member"><select value={selected} onChange={event => setSelected(event.target.value)}><option value="">Choose staff</option>{roster.data.records.map(item => <option key={String(item.key.id)} value={String(item.key.id)}>{rowText(item.row, "name")} · {rowText(item.row, "role")}</option>)}</select></Field>{staff && <StaffEditor key={`${selected}-${policy?.revision ?? 0}`} {...props} staff={staff} policy={policy} />}{!roster.data.records.length && <Empty>No staff roster has been uploaded.</Empty>}</>}</section>;
}
function StaffEditor({ outletId, canEdit, staff, policy }: Props & { staff: MirrorRecord; policy: MirrorRecord | undefined }) {
  const [overrides, setOverrides] = useState(() => policyValues(policy, "overrides")), command = useCommand(outletId);
  const admin = staff.row.role === "admin";
  return <form onSubmit={(event: FormEvent) => { event.preventDefault(); void command.send(() => ({ kind: "staff.update", targetId: String(staff.key.id), expectedRevision: policy?.revision ?? 0, payload: { overrides } })); }}><CommandNotice {...command} />{admin && <Notice>Administrator access is required for recovery and cannot be restricted here.</Notice>}<p className="muted">“Use role default” removes the override. The outlet applies its normal role rules.</p><fieldset disabled={!canEdit || admin || command.busy || !!command.saved}><div className="permission-grid">{permissions.map(([id, label, actions]) => <section key={id}><h3>{label}</h3>{actions.split(",").map(action => { const key = `${id}.${action}`; return <Field key={key} label={action === "delete" ? "Delete / reverse" : action[0]!.toUpperCase() + action.slice(1)}><select value={overrides[key] === undefined ? "default" : overrides[key] ? "allow" : "deny"} onChange={event => setOverrides(old => { const next = { ...old }; if (event.target.value === "default") delete next[key]; else next[key] = event.target.value === "allow"; return next; })}><option value="default">Use role default</option><option value="allow">Allow</option><option value="deny">Deny</option></select></Field>; })}</section>)}</div><button className="primary">{command.busy ? "Sending…" : command.saved ? "Change sent" : "Send staff permissions"}</button></fieldset><p className="muted small">Based on permission revision {policy?.revision ?? 0}. A newer outlet policy creates a conflict.</p></form>;
}
