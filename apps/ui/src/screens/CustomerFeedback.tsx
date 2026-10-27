import { useEffect, useState } from "react";
import { ApiError, apiFetch } from "../api";
import { stars, todayKey } from "../crm";

interface FeedbackRow {
  id: string; overall: number; food: number | null; service: number | null; ambience: number | null; comment: string | null;
  source: "qr" | "staff"; createdAt: number; billNo: number; customerName: string | null; customerPhone: string | null; recordedBy: string | null;
}
interface Summary { count: number; average: number | null; food: number | null; service: number | null; ambience: number | null }

const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return todayKey(d); };
const startOf = (key: string) => new Date(`${key}T00:00:00`).getTime();
const avg = (n: number | null) => n === null ? "—" : n.toFixed(1);

/** Ratings guests left through the receipt's QR code or staff recorded, newest first; low ratings stand out. */
export function CustomerFeedback() {
  const [from, setFrom] = useState(daysAgo(29));
  const [to, setTo] = useState(todayKey());
  const [lowOnly, setLowOnly] = useState(false);
  const [data, setData] = useState<{ feedback: FeedbackRow[]; summary: Summary } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const end = startOf(to) + 86_400_000;
    apiFetch<{ feedback: FeedbackRow[]; summary: Summary }>(`/api/feedback?from=${startOf(from)}&to=${end}${lowOnly ? "&maxRating=2" : ""}`)
      .then((r) => { if (active) { setData(r); setError(""); } })
      .catch((e) => { if (active) setError(e instanceof ApiError ? e.message : "Could not load feedback"); });
    return () => { active = false; };
  }, [from, to, lowOnly]);

  return <div className="panel">
    <div className="cash-drawer-form">
      <label>From <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value || from)} /></label>
      <label>To <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value || to)} /></label>
      <label className="crm-check"><input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} /> Only 1 and 2 stars</label>
    </div>
    {error && <p role="alert">{error}</p>}
    {data && <>
      <dl className="crm-tiles">
        <div><dt>Ratings</dt><dd>{data.summary.count}</dd></div>
        <div><dt>Overall</dt><dd>{avg(data.summary.average)}</dd></div>
        <div><dt>Food</dt><dd>{avg(data.summary.food)}</dd></div>
        <div><dt>Service</dt><dd>{avg(data.summary.service)}</dd></div>
        <div><dt>Ambience</dt><dd>{avg(data.summary.ambience)}</dd></div>
      </dl>
      <ul className="crm-feedback-list">{data.feedback.map((f) => <li key={f.id} className={f.overall <= 2 ? "crm-low" : ""}>
        <span className="crm-stars" aria-label={`${f.overall} out of 5`}>{stars(f.overall)}</span>{" "}
        <strong>{f.customerName ?? "Walk-in"}</strong>{f.customerPhone ? ` · ${f.customerPhone}` : ""} · Bill #{f.billNo} · {new Date(f.createdAt).toLocaleString()}
        {" · "}{f.source === "qr" ? "QR code" : `Recorded by ${f.recordedBy ?? "staff"}`}
        {(f.food || f.service || f.ambience) && <small className="muted"> · Food {f.food ?? "—"} · Service {f.service ?? "—"} · Ambience {f.ambience ?? "—"}</small>}
        {f.comment && <p>{f.comment}</p>}
      </li>)}{!data.feedback.length && <li className="muted">No feedback for these dates.</li>}</ul>
    </>}
  </div>;
}
