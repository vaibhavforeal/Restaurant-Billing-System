import { useEffect, useState } from "react";
import { DEFAULT_GST_RATES, GST_MODES, type GstMode } from "@masalapos/domain/gst";
import { financialYear, formatInvoiceNo } from "@masalapos/domain/invoice-numbers";
import { resolveReceiptStyle } from "@masalapos/domain/receipt-styles";
import { apiFetch } from "../api";
import { InfoTip } from "../InfoTip";
import { settingsForSave } from "../settings-save";
import { SaveStatus, useSettingsForm } from "../use-settings-form";
import type { SettingsData } from "../types";
import "../bill-settings.css";

const LINES_HINT = "Up to 3 lines, 48 characters each";
const field = { display: "grid", gap: 4 } as const;
const check = { display: "flex", alignItems: "center", gap: 8 } as const;

const SHOW_TOGGLES: Array<{ key: "billShowFssai" | "billShowCustomer" | "billShowTable" | "billShowServedBy" | "billShowItemGst"; label: string }> = [
  { key: "billShowFssai", label: "Show FSSAI number" },
  { key: "billShowCustomer", label: "Show customer name and phone" },
  { key: "billShowTable", label: "Show table" },
  { key: "billShowServedBy", label: "Show 'Served by'" },
  { key: "billShowItemGst", label: "Show each item's GST rate" },
];

/** The last good preview of the bill for these settings; an invalid form keeps the previous one and reports why. */
function useBillPreview(form: SettingsData | null) {
  const [html, setHtml] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!form) return;
    let current = true;
    const timer = setTimeout(() => {
      apiFetch<{ html: string }>("/api/settings/bill-preview", { method: "POST", body: JSON.stringify(settingsForSave(form)) })
        .then((r) => { if (current) { setHtml(r.html); setError(""); } })
        .catch((e) => { if (current) setError(e instanceof Error && e.message ? e.message : "Could not update the preview"); });
    }, 300);
    return () => { current = false; clearTimeout(timer); };
  }, [form]);
  return { html, error };
}

const GST_MODE_LABELS: Record<GstMode, string> = { included: "Prices include GST", exclusive: "Prices exclude GST, added on the bill", none: "No GST charged" };

/** Settings → Bill settings: tax, what the printed bill shows, and order handling, beside a live preview of the bill. */
export function BillSettings({ onOpenPrinters }: { onOpenPrinters: () => void }) {
  const { form, update, save, busy, status, message } = useSettingsForm("Could not save the bill settings");
  const preview = useBillPreview(form);
  const fy = financialYear(Date.now()).short;
  if (!form) return <div className="panel">{status === "error" ? <p role="alert">{message}</p> : <p role="status">Loading settings…</p>}</div>;
  return <div className="panel bill-settings">
    <div className="settings-form bill-settings-form">
      <fieldset className="bill-settings-group">
        <legend>Tax</legend>
        <label style={field}>
          <span>GST <InfoTip id="gst-settings-help">Applies to new bills. With GST included, the tax is part of your menu prices and is shown as an Includes GST block on the bill; items without their own rate use the default rate. With GST added on the bill, menu prices are before tax and CGST and SGST are added to each bill; this needs your GSTIN. With No GST charged, bills show no tax. Existing bills keep their original tax calculation.</InfoTip></span>
          <select value={form.gstMode} disabled={busy} aria-describedby="gst-settings-help"
            onChange={(e) => update({ gstMode: GST_MODES.find((m) => m === e.target.value) ?? "included" })}>
            {GST_MODES.map((mode) => <option key={mode} value={mode}>{GST_MODE_LABELS[mode]}</option>)}
          </select>
        </label>
        {form.gstMode !== "none" && <label style={field}>
          Default GST rate
          <select value={form.gstRate} disabled={busy} aria-describedby="gst-settings-help"
            onChange={(e) => update({ gstRate: Number(e.target.value) as SettingsData["gstRate"] })}>
            {DEFAULT_GST_RATES.map((rate) => <option key={rate} value={rate}>{rate}%</option>)}
          </select>
        </label>}
        {form.gstin.trim() !== "" && <>
          <label style={field}>
            <span>SAC code <InfoTip id="sac-settings-help">Printed on tax invoices and used in the GSTR-1 HSN/SAC summary. 996331 is restaurant service; change it only if your accountant asks.</InfoTip></span>
            <input value={form.sacCode} inputMode="numeric" maxLength={8} disabled={busy} aria-describedby="sac-settings-help"
              onChange={(e) => update({ sacCode: e.target.value.replace(/\D/g, "") })} />
          </label>
          <label style={field}>
            <span>Zomato's GSTIN <InfoTip id="zomato-gstin-help">Zomato pays the GST on its orders (section 9(5)); GSTR-1 Table 14 reports those sales against Zomato's GSTIN for your state. Find it on Zomato's monthly statement. Leave blank if you don't sell on Zomato.</InfoTip></span>
            <input value={form.zomatoGstin} maxLength={15} autoCapitalize="characters" spellCheck={false} disabled={busy} aria-describedby="zomato-gstin-help"
              onChange={(e) => update({ zomatoGstin: e.target.value.toUpperCase() })} />
          </label>
        </>}
      </fieldset>

      <fieldset className="bill-settings-group">
        <legend>Numbering &amp; rounding</legend>
        <label style={field}>
          <span>Invoice prefix <InfoTip id="invoice-prefix-help">Optional, up to 4 letters or digits. Bills are numbered {formatInvoiceNo(form.invoicePrefix, fy, 1)} and start again at 0001 every 1 April.</InfoTip></span>
          <input value={form.invoicePrefix} maxLength={4} autoCapitalize="characters" spellCheck={false} disabled={busy} aria-describedby="invoice-prefix-help invoice-prefix-cn"
            onChange={(e) => update({ invoicePrefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") })} />
          <small id="invoice-prefix-cn">Credit notes are numbered CN/{fy}/001.</small>
        </label>
        <label style={field}>
          <span>Round off total <InfoTip id="round-off-help">Applies to new bills. Refunds use each bill's own rounding.</InfoTip></span>
          <select value={form.roundOff} disabled={busy} aria-describedby="round-off-help"
            onChange={(e) => update({ roundOff: e.target.value as SettingsData["roundOff"] })}>
            <option value="rupee">To the nearest ₹1</option>
            <option value="half">To the nearest 50 paise</option>
            <option value="off">No rounding (exact paise)</option>
          </select>
        </label>
      </fieldset>

      <fieldset className="bill-settings-group">
        <legend>Printed bill</legend>
        <label style={field}>
          <span>Bill style <InfoTip id="bill-style-help">Applies to new bills; reprints keep their saved style. Preview/PDF uses the selected typeface. Thermal printing uses the printer's built-in font with matching spacing and emphasis.</InfoTip></span>
          <select value={form.receiptStyle ?? "classic"} onChange={(e) => update({ receiptStyle: resolveReceiptStyle(e.target.value) })} disabled={busy} aria-describedby="bill-style-help">
            <option value="classic">Classic - Receipt mono</option>
            <option value="modern">Modern - Bold sans serif</option>
            <option value="heritage">Heritage - Traditional serif</option>
            <option value="compact">Compact - Space-saving sans serif</option>
          </select>
        </label>
        <label style={field}>
          Header lines
          <textarea rows={3} value={form.receiptHeader} disabled={busy} aria-describedby="receipt-header-hint" onChange={(e) => update({ receiptHeader: e.target.value })} />
          <small id="receipt-header-hint">{LINES_HINT}</small>
        </label>
        <label style={field}>
          Footer lines
          <textarea rows={3} value={form.receiptFooter} disabled={busy} aria-describedby="receipt-footer-hint" onChange={(e) => update({ receiptFooter: e.target.value })} />
          <small id="receipt-footer-hint">{LINES_HINT}</small>
        </label>
        <label style={field}>
          <span>UPI ID for bill payments <InfoTip id="upi-settings-help">Save your restaurant’s UPI ID once to print a payment QR on new unpaid bills, with the bill amount filled in. Leave blank to disable for new bills. Existing bills keep their saved UPI ID.</InfoTip></span>
          <input value={form.upiId} placeholder="restaurant@bank" maxLength={255}
            autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={busy}
            aria-describedby="upi-settings-help"
            onChange={(e) => update({ upiId: e.target.value })} />
        </label>
        {SHOW_TOGGLES.map(({ key, label }) => <label key={key} style={check}>
          <input type="checkbox" checked={form[key]} disabled={busy} onChange={(e) => update({ [key]: e.target.checked })} />
          <span>{label}{key === "billShowItemGst" && <small> Only printed on bills that charge GST.</small>}</span>
        </label>)}
        <button type="button" className="link-button" onClick={onOpenPrinters}>Bill copies are set per printer</button>
      </fieldset>

      <fieldset className="bill-settings-group">
        <legend>Order handling</legend>
        <label style={field}>
          <span>Kitchen slip when a sent item is changed <InfoTip id="kot-edit-help">When staff change the quantity or note of an item already sent to the kitchen, a CHANGED slip can print at that kitchen station. The kitchen screen updates either way.</InfoTip></span>
          <select value={form.kotEditPrint} disabled={busy} aria-describedby="kot-edit-help"
            onChange={(e) => update({ kotEditPrint: e.target.value as SettingsData["kotEditPrint"] })}>
            <option value="ask">Ask each time</option>
            <option value="always">Always print</option>
            <option value="never">Never print</option>
          </select>
        </label>
        <label style={check}>
          <input type="checkbox" checked={form.holdOrdersEnabled} disabled={busy} aria-describedby="hold-orders-help"
            onChange={(e) => update({ holdOrdersEnabled: e.target.checked })} />
          <span>Hold orders <InfoTip id="hold-orders-help">Staff can hold an order to finish later on any device, and hold dishes back from the kitchen until they fire them.</InfoTip></span>
        </label>
      </fieldset>

      <button className="primary" onClick={save} style={{ fontWeight: 700 }} disabled={busy}>Save</button>
      <SaveStatus status={status} message={message} />
      {preview.error && <p role="alert" style={{ color: "var(--danger-text, crimson)" }}>{preview.error}</p>}
    </div>
    <div className="bill-settings-preview">
      {preview.html ? <iframe sandbox="allow-same-origin" srcDoc={preview.html} title="Bill preview" /> : <p role="status">Preparing the preview…</p>}
    </div>
  </div>;
}
