import { useId, type ReactNode } from "react";
import { OFFER_DAYS, type OfferChoice, type OfferErrors, type OfferFormState } from "../offer-form";
import type { OrderTypeInfo } from "../types";

export function OfferForm({ value, errors, busy, categories, products, orderTypes, onChange, onSave, onCancel, error }: {
  value: OfferFormState; errors: OfferErrors; busy: boolean; categories: OfferChoice[]; products: OfferChoice[]; orderTypes: OrderTypeInfo[];
  onChange: (value: OfferFormState) => void; onSave: () => void; onCancel: () => void; error: string;
}) {
  const prefix = useId();
  const id = (field: string) => `${prefix}-${field}`;
  const patch = <K extends keyof OfferFormState>(field: K, next: OfferFormState[K]) => onChange({ ...value, [field]: next });
  const errorFor = (field: string) => errors[field] && <span className="offer-field-error" id={`${id(field)}-error`}>{errors[field]}</span>;
  const a11y = (field: string) => ({ id: id(field), "aria-invalid": !!errors[field], "aria-describedby": errors[field] ? `${id(field)}-error` : undefined });
  function input(field: "name" | "buyQty" | "getQty" | "percentBp" | "amountPaise" | "minBillPaise" | "maxDiscountPaise" | "validFrom" | "validUntil" | "timeFrom" | "timeUntil", label: string, type = "text") {
    const numeric = ["buyQty", "getQty", "percentBp", "amountPaise", "minBillPaise", "maxDiscountPaise"].includes(field);
    // The shared schema puts a missing discount on percentBp even when the owner chose an amount.
    const errorField = field === "amountPaise" && !errors.amountPaise && errors.percentBp ? "percentBp" : field;
    return <div className="offer-field"><label htmlFor={id(field)}>{label}<input {...a11y(errorField)} id={id(field)} type={type} value={value[field]} maxLength={field === "name" ? 40 : undefined}
      inputMode={numeric ? (field === "buyQty" || field === "getQty" ? "numeric" : "decimal") : undefined}
      onChange={(event) => patch(field, event.target.value)} /></label>{errorFor(errorField)}</div>;
  }
  function picker(field: "categoryIds" | "productIds" | "orderTypeIds", label: string, singular: string, choices: OfferChoice[], max: number, hint?: ReactNode) {
    const selected = value[field];
    return <fieldset className="offer-picker" aria-describedby={errors[field] ? `${id(field)}-error` : undefined}>
      <legend>{label}</legend>{hint && <p className="offer-help">{hint}</p>}
      {selected.map((selectedId, index) => <div className="offer-picker-row" key={index}>
        <select aria-label={`${singular} ${index + 1}`} aria-invalid={!!errors[field]} value={selectedId} onChange={(event) => patch(field, selected.map((item, i) => i === index ? event.target.value : item))}>
          <option value="">Choose {singular.toLowerCase()}</option>
          {selectedId && !choices.some((choice) => choice.id === selectedId) && <option value={selectedId} disabled>Unavailable selection</option>}
          {choices.filter((choice) => choice.id === selectedId || (choice.isActive && !selected.includes(choice.id))).map((choice) => <option key={choice.id} value={choice.id} disabled={!choice.isActive}>{choice.name}{!choice.isActive ? " (Inactive)" : ""}</option>)}
        </select>
        <button type="button" aria-label={`Remove ${singular.toLowerCase()} ${index + 1}`} onClick={() => patch(field, selected.filter((_, i) => i !== index))}>Remove</button>
      </div>)}
      <button type="button" disabled={selected.length >= max || selected.includes("") || !choices.some((choice) => choice.isActive && !selected.includes(choice.id))} onClick={() => patch(field, [...selected, ""])}>Add {singular.toLowerCase()}</button>
      {errorFor(field)}
    </fieldset>;
  }
  const buyGet = value.kind === "buy_get", bill = value.kind === "bill_off";
  const percent = buyGet || value.discountMode === "percent";
  return <form className="offer-form" noValidate onSubmit={(event) => { event.preventDefault(); onSave(); }}>
    <fieldset className="offer-form-fields" disabled={busy}>
      <div className="offer-field-grid">
        <div className="offer-field"><label htmlFor={id("kind")}>Offer kind</label><select {...a11y("kind")} value={value.kind} onChange={(event) => patch("kind", event.target.value as OfferFormState["kind"])}>
          <option value="buy_get">Buy and get</option><option value="item_off">Discount on items</option><option value="bill_off">Discount on the bill</option>
        </select>{errorFor("kind")}</div>
        {input("name", "Name")}
      </div>
      <label className="offer-check"><input type="checkbox" checked={value.active} onChange={(event) => patch("active", event.target.checked)} />Offer on</label>
      {buyGet && <div className="offer-field-grid">{input("buyQty", "Buy quantity")}{input("getQty", "Get quantity")}</div>}
      {!buyGet && <div className="offer-field"><label htmlFor={id("discountMode")}>Discount type</label><select id={id("discountMode")} value={value.discountMode} onChange={(event) => patch("discountMode", event.target.value as "percent" | "amount")}><option value="percent">Percentage</option><option value="amount">Rupee amount</option></select></div>}
      {percent ? input("percentBp", buyGet ? "Discount on reward items (%)" : "Discount (%)") : input("amountPaise", bill ? "Discount (₹)" : "Discount per item (₹)")}
      {buyGet && <><p className="offer-help">100% off means free. Buy and get quantities must each be 1–20.</p><label className="offer-check"><input type="checkbox" checked={value.sameItemOnly} onChange={(event) => patch("sameItemOnly", event.target.checked)} />Same item only</label><p className="offer-help">Require the same dish and size for the bought and reward items.</p></>}
      {bill && <div className="offer-field-grid">{input("minBillPaise", "Minimum bill (₹, optional)")}{percent && input("maxDiscountPaise", "Maximum discount (₹, optional)")}</div>}
      {!bill && <div className="offer-field-grid">
        {picker("categoryIds", "Categories", "Category", categories, 200)}
        {picker("productIds", "Items", "Item", products, 200, "Each item includes all its sizes. Choose at least one category or item.")}
      </div>}
      <fieldset className="offer-conditions"><legend>When it applies</legend>
        <p className="offer-help">Leave dates, times and order types blank for no restriction. Zomato orders never get offers.</p>
        <div className="offer-field-grid">{input("validFrom", "Start date (optional)", "date")}{input("validUntil", "End date (optional)", "date")}</div>
        <fieldset className="offer-days" aria-describedby={errors.days ? `${id("days")}-error` : undefined}><legend>Days</legend><div className="offer-day-choices">
          {OFFER_DAYS.map((day, index) => <label className="offer-check" key={day}><input type="checkbox" checked={value.days.includes(index)} onChange={(event) => patch("days", event.target.checked ? [...value.days, index].sort((a, b) => a - b) : value.days.filter((day) => day !== index))} />{day}</label>)}
        </div>{errorFor("days")}</fieldset>
        <div className="offer-field-grid">{input("timeFrom", "Start time (optional)", "time")}{input("timeUntil", "End time (optional)", "time")}</div>
        {value.timeFrom && value.timeUntil && value.timeFrom > value.timeUntil && <p className="offer-help">Ends next morning. After midnight still counts as the day the offer started.</p>}
        {picker("orderTypeIds", "Order types", "Order type", orderTypes.filter((type) => type.kind !== "aggregator"), 20, "Leave empty for all eligible order types.")}
      </fieldset>
      {(error || Object.keys(errors).length > 0) && <p role="alert" className="error-message">{error || errors.form || "Check the highlighted fields."}</p>}
      <div className="offer-form-actions"><button type="button" onClick={onCancel}>Cancel</button><button type="submit" className="primary">{busy ? "Saving…" : "Save offer"}</button></div>
    </fieldset>
  </form>;
}
