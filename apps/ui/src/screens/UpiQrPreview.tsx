import { useEffect, useState } from "react";
import { apiFetch } from "../api";
import { paiseToRupees } from "../money";
import { WorkspaceDialog } from "../WorkspaceDialog";
import "../upi-qr-preview.css";

interface UpiPaymentPreview {
  billId: string; billNo: number; restaurantName: string; upiId: string;
  amountPaise: number; qrDataUrl: string;
}

export function UpiQrPreview({ billId, open, onClose }: { billId: string; open: boolean; onClose: () => void }) {
  const [payment, setPayment] = useState<UpiPaymentPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    setPayment(null); setError(""); setLoading(true);
    if (!open) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      try {
        const result = await apiFetch<{ payment: UpiPaymentPreview | null }>(`/api/bills/${billId}/upi-qr`, { cache: "no-store" });
        if (active) { setPayment(result.payment); setError(""); }
      } catch (e) {
        // Hide a previously displayed QR if its unpaid status cannot be refreshed.
        if (active) { setPayment(null); setError(e instanceof Error ? e.message : "Could not load the payment QR"); }
      } finally {
        if (active) { setLoading(false); timer = setTimeout(() => void refresh(), 5000); }
      }
    }
    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, [billId, open, retry]);

  return <WorkspaceDialog open={open} title="Scan & pay with UPI" onClose={onClose} className="upi-preview-dialog">
    {loading ? <p role="status">Loading payment QR…</p> : error ? <div role="alert">
      <p>{error}</p><button onClick={() => setRetry((value) => value + 1)}>Retry QR</button>
    </div> : payment?.billId === billId ? <div className="upi-preview">
      <p className="upi-preview-restaurant">{payment.restaurantName}</p>
      <p className="upi-preview-bill">Bill #{payment.billNo}</p>
      <p className="upi-preview-amount">₹{paiseToRupees(payment.amountPaise)}</p>
      <img className="upi-preview-image" src={payment.qrDataUrl} width={300} height={300}
        alt={`UPI payment QR for bill ${payment.billNo}, INR ${paiseToRupees(payment.amountPaise)}`} />
      <p className="upi-preview-id">{payment.upiId}</p>
      <p>Scan with your UPI app. The bill amount is filled in.</p>
      <p className="upi-preview-note">Verify payment in the restaurant’s UPI app before settling the bill.</p>
    </div> : <p role="status">This bill has no UPI payment due, or no UPI ID was saved with it.</p>}
  </WorkspaceDialog>;
}
