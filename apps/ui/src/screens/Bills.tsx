import { ChoiceTiles } from "../ChoiceTiles";
import { useEffect, useRef, useState } from "react";
import type { Bill } from "@forkflow/domain";
import { BillHistory, type BillHistoryStatus, type BillHistorySnapshot } from "../bill-history";
import { apiFetch, session } from "../api";
import { billStatusLabel } from "../credit-note-form";
import { paiseToRupees } from "../money";
import { connectWs } from "../ws";
import { billContextLabel } from "../zomato-desk";

export function Bills({ onOpenOrder }: { onOpenOrder: (id: string) => void }) {
  const [history] = useState(() => new BillHistory(async (status, before, signal) => {
    const cursor = before === undefined ? "" : `&before=${before}`;
    const timeout = AbortSignal.timeout(15_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const result = await apiFetch<{ bills: Bill[] }>(`/api/bills?status=${status}${cursor}`, { signal: requestSignal });
    return result.bills;
  }));
  const [snapshot, setSnapshot] = useState<BillHistorySnapshot>(() => history.getSnapshot());
  const scroller = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const unsubscribe = history.subscribe((next) => {
      const root = scroller.current;
      const rootTop = root?.getBoundingClientRect().top ?? 0;
      const anchorRow = root && [...root.querySelectorAll<HTMLTableRowElement>("tbody tr[data-bill-id]")]
        .find(row => row.getBoundingClientRect().bottom > rootTop);
      const anchor = anchorRow ? {
        id: anchorRow.dataset.billId!,
        offset: anchorRow.getBoundingClientRect().top - rootTop,
      } : null;
      setSnapshot(next);
      if (root && anchor) window.requestAnimationFrame(() => {
        const row = [...root.querySelectorAll<HTMLTableRowElement>("tbody tr[data-bill-id]")]
          .find(candidate => candidate.dataset.billId === anchor.id);
        if (row) root.scrollTop += row.getBoundingClientRect().top - root.getBoundingClientRect().top - anchor.offset;
      });
    });
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => { clearTimeout(scheduled); scheduled = setTimeout(() => { void history.refresh(); }, 250); };
    const dispose = connectWs({
      onEvent: (event) => { if (event === "order.updated") schedule(); },
      onStatus: (connected) => { if (connected) schedule(); },
      onAuthFail: () => session.clear(),
    });
    void history.refresh();
    return () => { clearTimeout(scheduled); dispose(); unsubscribe(); history.dispose(); };
  }, [history]);

  const changeStatus = (status: BillHistoryStatus) => {
    history.setStatus(status);
    void history.refresh();
  };
  return <section className="legacy-screen pos-history">
    <div className="pos-toolbar"><h2>Bills</h2>
    <div className="choice-field">Show <ChoiceTiles aria-label="Show" value={snapshot.status} onChange={(choiceValue) => changeStatus(choiceValue as BillHistoryStatus)} disabled={snapshot.busy}><option value="unpaid">Unpaid</option><option value="paid">Paid</option><option value="all">All bills</option></ChoiceTiles></div></div>
    <p role="alert" style={{ color: "var(--danger-text, crimson)" }}>{snapshot.error}</p>
    {!snapshot.bills.length && <p>No bills to show.</p>}
    <div className="pos-table-scroll" tabIndex={0} role="region" aria-label="Scrollable records" ref={scroller}><table style={{ width: "100%", textAlign: "left", borderSpacing: "8px 16px" }}>
      <thead><tr><th>Bill</th><th>Date</th><th>Table / parcel</th><th className="pos-money">Total</th><th>Status</th><th>Action</th></tr></thead>
      <tbody>{snapshot.bills.map((b) => <tr key={b.id} data-bill-id={b.id}><td>#{b.billNo}</td><td>{new Date(b.createdAt).toLocaleString()}</td><td>{billContextLabel(b.receipt)}</td><td className="pos-money">₹{paiseToRupees(b.totalPaise)}</td><td><span className={`status ${b.status} refund-${b.refundState}`}>{billStatusLabel(b)}</span></td><td><button onClick={() => onOpenOrder(b.orderId)}>Open bill #{b.billNo}</button></td></tr>)}</tbody>
    </table></div>
    {snapshot.more && <button disabled={snapshot.busy} onClick={() => { void history.loadOlder(); }}>Load older bills</button>}
  </section>;
}
