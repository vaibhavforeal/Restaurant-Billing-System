import { useEffect, useState } from "react";
import "../feedback-page.css";

interface Visit { restaurantName: string; billNo: number; billedAt: number; submitted: boolean; open: boolean }
type Ratings = { overall: number; food: number; service: number; ambience: number };
const ASPECTS: Array<{ key: keyof Ratings; label: string }> = [
  { key: "overall", label: "Overall" }, { key: "food", label: "Food" }, { key: "service", label: "Service" }, { key: "ambience", label: "Ambience" },
];

/** The guest's page behind the receipt's "Rate your visit" QR code. No sign-in: the link itself is the key, for one rating. */
export function FeedbackPage({ token }: { token: string }) {
  const [visit, setVisit] = useState<Visit | null>(null);
  const [problem, setProblem] = useState("");
  const [ratings, setRatings] = useState<Ratings>({ overall: 0, food: 0, service: 0, ambience: 0 });
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    fetch(`/api/guest/feedback/${encodeURIComponent(token)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "This link is not valid");
        setVisit(await res.json() as Visit);
      })
      .catch((e: unknown) => setProblem(e instanceof Error ? e.message : "This link is not valid"));
  }, [token]);

  async function submit() {
    if (busy || !ratings.overall) return;
    setBusy(true); setProblem("");
    try {
      const res = await fetch(`/api/guest/feedback/${encodeURIComponent(token)}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ overall: ratings.overall, food: ratings.food || null, service: ratings.service || null, ambience: ratings.ambience || null, comment }),
      });
      if (!res.ok && res.status !== 409) throw new Error((await res.json().catch(() => ({}))).error ?? "Could not send your rating");
      setDone(true);
    } catch (e) { setProblem(e instanceof Error ? e.message : "Could not send your rating"); }
    finally { setBusy(false); }
  }

  return <main className="feedback-page">
    <section className="feedback-card">
      {visit && <header><h1>{visit.restaurantName}</h1><p>Bill #{visit.billNo} · {new Date(visit.billedAt).toLocaleDateString()}</p></header>}
      {done || visit?.submitted ? <p className="feedback-thanks">Thank you for your feedback!</p>
        : visit && !visit.open ? <p>Ratings for this visit have closed. We hope to see you again soon.</p>
        : visit ? <>
          <h2>How was your visit?</h2>
          {ASPECTS.map(({ key, label }) => <div key={key} className="feedback-row" role="radiogroup" aria-label={label}>
            <span>{label}{key === "overall" ? "" : <small> (optional)</small>}</span>
            <span className="feedback-stars">{[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" role="radio" aria-checked={ratings[key] === n} aria-label={`${n} star${n === 1 ? "" : "s"}`}
              className={ratings[key] >= n ? "on" : ""} onClick={() => setRatings({ ...ratings, [key]: ratings[key] === n && key !== "overall" ? 0 : n })}>★</button>)}</span>
          </div>)}
          <label className="feedback-comment">Anything you'd like to tell us? <textarea maxLength={1000} rows={4} value={comment} onChange={(e) => setComment(e.target.value)} /></label>
          <button type="button" className="feedback-submit" disabled={busy || !ratings.overall} onClick={() => void submit()}>{busy ? "Sending…" : "Send"}</button>
        </> : !problem && <p>Loading…</p>}
      {problem && <p role="alert">{problem}</p>}
    </section>
  </main>;
}
