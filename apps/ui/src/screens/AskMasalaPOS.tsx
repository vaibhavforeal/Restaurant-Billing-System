import { useState } from "react";
import { apiFetch } from "../api";
import { aiErrorText, aiRequestInit, appendTurn, historyForRequest, type ChatTurn } from "../ask-chat";

const EXAMPLES = ["How did this week compare with last week?", "Which dish should I promote?", "Who cancels most after KOT?"];
type Answer = { question: string; answer: string; figuresUsed: string[]; model: string };

/** Reports → Ask MasalaPOS (admins): plain-English questions answered from the restaurant's figures. Not saved. */
export function AskMasalaPOS({ setup = false }: { setup?: boolean }) {
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function ask(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    setBusy(true); setError("");
    try {
      const reply = await apiFetch<{ answer: string; figuresUsed: string[]; model: string }>("/api/ai/ask", aiRequestInit("ask", { question: q, history: historyForRequest(turns) }));
      setTurns((old) => appendTurn(appendTurn(old, "user", q), "assistant", reply.answer));
      setAnswers((old) => [...old, { question: q, ...reply }]);
      setQuestion("");
    } catch (e) { setError(aiErrorText(e)); }
    finally { setBusy(false); }
  }

  if (setup) return <section className="ask-masalapos" aria-label="Ask MasalaPOS" style={{ display: "grid", gap: 12, maxWidth: 820 }}>
    <div className="page-header"><h3>Ask MasalaPOS</h3></div>
    <p className="ask-setup" role="status" style={{ margin: 0 }}>Set up the AI assistant in Settings → Restaurant profile → AI assistant: add an OpenRouter key and press Test. Then ask about sales in plain English here.</p>
  </section>;
  return <section className="ask-masalapos" aria-label="Ask MasalaPOS" style={{ display: "grid", gap: 12, maxWidth: 820 }}>
    <div className="page-header"><h3>Ask MasalaPOS</h3></div>
    <p className="muted" style={{ margin: 0 }}>Ask about sales in plain English. Answers come only from this restaurant's figures; nothing here is saved.</p>
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{EXAMPLES.map((example) =>
      <button key={example} type="button" className="ask-example" disabled={busy} onClick={() => void ask(example)}>{example}</button>)}</div>
    <form onSubmit={(e) => { e.preventDefault(); void ask(question); }} style={{ display: "flex", gap: 8 }}>
      <input aria-label="Your question" maxLength={1000} value={question} disabled={busy} placeholder="e.g. Why were Tuesday's sales low?" onChange={(e) => setQuestion(e.target.value)} style={{ flex: 1 }} />
      <button className="primary" disabled={busy || !question.trim()}>{busy ? "Thinking…" : "Ask"}</button>
    </form>
    {error && <p role="alert" style={{ color: "var(--danger-text, crimson)", margin: 0 }}>{error}</p>}
    {busy && <p role="status" className="muted" style={{ margin: 0 }}>Looking at the figures… this can take a minute or two.</p>}
    <div className="ask-answers" style={{ display: "grid", gap: 12 }}>{[...answers].reverse().map((a, i) =>
      <article key={answers.length - i} className="ask-answer" style={{ border: "1px solid var(--line)", borderRadius: "var(--radius-panel, 6px)", padding: 12 }}>
        <p style={{ margin: "0 0 6px", fontWeight: 650 }}>{a.question}</p>
        <div style={{ whiteSpace: "pre-wrap" }}>{a.answer}</div>
        {a.figuresUsed.length > 0 && <details style={{ marginTop: 8 }}><summary className="muted" style={{ fontSize: 12 }}>Figures used</summary>
          <ul className="ask-figures" style={{ margin: "4px 0 0", fontSize: 12 }}>{a.figuresUsed.map((f, n) => <li key={n}>{f}</li>)}</ul></details>}
        <small className="muted">Answered by {a.model}</small>
      </article>)}</div>
  </section>;
}
