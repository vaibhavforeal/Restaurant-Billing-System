import { useEffect, useState } from "react";
import type { Bill } from "@forkflow/domain";
import { apiFetch, session } from "../api";
import { billStatusLabel } from "../credit-note-form";
import { paiseToRupees } from "../money";
import { connectWs } from "../ws";
import { TableScroller } from "../PosControls";
import { billContextLabel } from "../zomato-desk";

export function Bills({ onOpenOrder }: { onOpenOrder: (id: string) => void }) {
  const [bills, setBills] = useState<Bill[]>([]);
  const [status, setStatus] = useState("unpaid");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  useEffect(() => {
    let active = true;
    const reload = async () => {
      try {
        const result = await apiFetch<{ bills: Bill[] }>(`/api/bills?status=${status}`);
        if (active) { setBills(result.bills); setMore(result.bills.length === 100); setError(""); }
      } catch (e) { if (active) setError(e instanceof Error ? e.message : "Failed to load bills"); }
    };
    void reload();
    const dispose = connectWs({ onEvent: (event) => { if (event === "order.updated") void reload(); }, onStatus: (connected) => { if (connected) void reload(); }, onAuthFail: () => session.clear() });
    return () => { active = false; dispose(); };
  }, [status]);
  return <section className="legacy-screen pos-history">
    <div className="pos-toolbar"><h2>Bills</h2>
    <label>Show <select value={status} onChange={(e) => setStatus(e.target.value)} disabled={busy}><option value="unpaid">Unpaid</option><option value="paid">Paid</option><option value="all">All bills</option></select></label></div>
    <p role="alert" style={{ color: "var(--danger-text, crimson)" }}>{error}</p>
    {!bills.length && <p>No bills to show.</p>}
    <TableScroller><table style={{ width: "100%", textAlign: "left", borderSpacing: "8px 16px" }}>
      <thead><tr><th>Bill</th><th>Date</th><th>Table / parcel</th><th className="pos-money">Total</th><th>Status</th><th>Action</th></tr></thead>
      <tbody>{bills.map((b) => <tr key={b.id}><td>#{b.billNo}</td><td>{new Date(b.createdAt).toLocaleString()}</td><td>{billContextLabel(b.receipt)}</td><td className="pos-money">₹{paiseToRupees(b.totalPaise)}</td><td><span className={`status ${b.status} refund-${b.refundState}`}>{billStatusLabel(b)}</span></td><td><button onClick={() => onOpenOrder(b.orderId)}>Open bill #{b.billNo}</button></td></tr>)}</tbody>
    </table></TableScroller>
    {more && <button disabled={busy} onClick={async () => {
      setBusy(true);
      try {
        const result = await apiFetch<{ bills: Bill[] }>(`/api/bills?status=${status}&before=${bills[bills.length - 1]!.billNo}`);
        setBills((prior) => [...prior, ...result.bills.filter((b) => !prior.some((p) => p.id === b.id))]); setMore(result.bills.length === 100);
      } catch (e) { setError(e instanceof Error ? e.message : "Failed to load older bills"); }
      finally { setBusy(false); }
    }}>Load older bills</button>}
  </section>;
}
