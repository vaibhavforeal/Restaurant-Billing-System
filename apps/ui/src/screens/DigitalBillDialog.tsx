import { useEffect, useState } from "react";
import type { Bill } from "@masalapos/domain";
import { apiFetch, authHeaders } from "../api";
import { WorkspaceDialog } from "../WorkspaceDialog";
import { paiseToRupees } from "../money";

export function DigitalBillDialog({ orderId, onClose, onCheckout, onBusyChange }: {
  orderId: string; onClose: () => void; onCheckout: () => void; onBusyChange: (busy: boolean) => void;
}) {
  const [bill, setBill] = useState<Bill | null>(null);
  const [receipt, setReceipt] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const result = await apiFetch<{ bill: Bill | null }>(`/api/orders/${orderId}/bill`);
        if (result.bill) {
          const response = await fetch(`/api/bills/${result.bill.id}/receipt`, { headers: authHeaders() });
          if (!response.ok) throw new Error("Could not load the receipt. Close and retry.");
          const html = await response.text();
          if (active) { setBill(result.bill); setReceipt(html); }
        }
      } catch (e) { if (active) setError(e instanceof Error ? e.message : "Could not load the bill."); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [orderId]);
  const file = () => new File([receipt], `Bill-${bill!.billNo}.html`, { type: "text/html" });
  const shareable = !!receipt && typeof navigator.canShare === "function" && navigator.canShare({ files: [file()] });
  async function share() {
    if (busy || !bill) return;
    setBusy(true); onBusyChange(true); setError("");
    try { await navigator.share({ files: [file()], title: `Bill #${bill.billNo}` }); setMessage("Bill handed to your selected sharing app."); }
    catch (e) { if (!(e instanceof DOMException && e.name === "AbortError")) setError("Sharing is unavailable. Download the bill and attach it in your messaging app."); }
    finally { setBusy(false); onBusyChange(false); }
  }
  function download() {
    const url = URL.createObjectURL(file()), link = document.createElement("a");
    link.href = url; link.download = `Bill-${bill!.billNo}.html`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMessage("Digital bill downloaded. Attach it in your messaging app to send it to the customer.");
  }
  return <WorkspaceDialog open title="Send digital bill" busy={busy} onClose={onClose} className="table-summary-dialog">
    {error && <p role="alert" className="error-message">{error}</p>}
    {message && <p role="status">{message}</p>}
    {loading ? <p role="status">Loading digital bill…</p> : bill ? <>
      <p><strong>Bill #{bill.billNo}</strong> · ₹{paiseToRupees(bill.totalPaise)} · {bill.status}</p>
      <p>Share the receipt file using an app on this device, or download it to attach to a message. The customer can open the file without signing in.</p>
      <div className="table-digital-actions">{shareable && <button className="primary" disabled={busy} onClick={() => void share()}>Share digital bill</button>}<button disabled={busy} onClick={download}>Download digital bill</button></div>
    </> : !error && <><p>Issue the bill in Checkout before sending a digital receipt.</p><button className="primary" onClick={onCheckout}>Open checkout</button></>}
  </WorkspaceDialog>;
}
