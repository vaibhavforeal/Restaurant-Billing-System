import { useEffect, useRef, useState, type ReactNode } from "react";
import { apiFetch } from "../api";
import { AiText } from "../AiText";
import { aiErrorText, aiRequestInit, appendTurn, historyForRequest, type ChatTurn } from "../ask-chat";
import { Icon } from "../Icon";
import "../ask-masalapos.css";

const EXAMPLES = ["How did this week compare with last week?", "Which dish should I promote?", "Who cancels most after KOT?"];
type Answer = { question: string; answer: string; figuresUsed: string[]; model: string };

/** The answer's card: "MasalaPOS AI", the answer, the figures it used as chips, and the model that wrote it. */
export function AiAnswerCard({ text, figuresUsed = [], model, label = "MasalaPOS AI", children }: { text: string; figuresUsed?: string[]; model: string; label?: string; children?: ReactNode }) {
  return <article className="ai-card">
    <div className="ai-card-label"><Icon name="sparkle" size={15} />{label}</div>
    <AiText text={text} />
    <div className="ai-card-foot">
      {figuresUsed.length > 0 && <><span className="ai-figures-title">Figures used:</span>{figuresUsed.map((f, n) => <span key={n} className="ai-figure">{f}</span>)}</>}
      {children}
      {model && <span className="ai-model" title="The AI model that wrote this">{model}</span>}
    </div>
  </article>;
}

export function AiThinking({ text }: { text: string }) {
  return <p role="status" className="ai-thinking"><span className="ai-dots" aria-hidden="true"><span /><span /><span /></span>{text}</p>;
}

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

  if (setup) return <section className="ask-masalapos" aria-label="Ask MasalaPOS">
    <div className="page-header"><h3>Ask MasalaPOS</h3></div>
    <p className="ask-setup" role="status" style={{ margin: 0 }}>The AI assistant isn't on for this restaurant yet. See Settings → Restaurant profile → AI assistant, or contact MasalaPOS to add it. Then ask about sales in plain English here.</p>
  </section>;
  return <section className="ask-masalapos" aria-label="Ask MasalaPOS">
    <div className="page-header"><h3>Ask MasalaPOS</h3></div>
    <p className="ask-intro">Ask about sales in plain English. Answers come only from this restaurant's figures; nothing here is saved.</p>
    <div className="ask-examples">{EXAMPLES.map((example) =>
      <button key={example} type="button" className="ask-example" disabled={busy} onClick={() => void ask(example)}>{example}</button>)}</div>
    <form className="ask-form" onSubmit={(e) => { e.preventDefault(); void ask(question); }}>
      <input aria-label="Your question" maxLength={1000} value={question} disabled={busy} placeholder="e.g. Why were Tuesday's sales low?" onChange={(e) => setQuestion(e.target.value)} />
      <button className="primary" disabled={busy || !question.trim()}>{busy ? "Thinking…" : "Ask"}</button>
    </form>
    {error && <p role="alert" className="ask-error">{error}</p>}
    {busy && <AiThinking text="Looking at the figures… this can take a minute or two." />}
    <div className="ask-answers">{[...answers].reverse().map((a, i) =>
      <div key={answers.length - i} className="ask-turn ask-answer">
        <p className="ask-question"><small>You asked</small>{a.question}</p>
        <AiAnswerCard text={a.answer} figuresUsed={a.figuresUsed} model={a.model} />
      </div>)}</div>
  </section>;
}

/**
 * Reports: a slim "Ask AI" tab on the right edge that slides Ask MasalaPOS in as a side panel over the open report, so questions can be
 * asked while looking at the figures. Closing only hides it: the conversation stays until Reports is left.
 */
export function AskSidePanel({ setup }: { setup: boolean }) {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLInputElement>('input[aria-label="Your question"]')?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented && !document.querySelector("dialog[open]")) setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  return <>
    <button type="button" className="ask-side-tab" aria-expanded={open} aria-controls="ask-panel" onClick={() => setOpen(true)} title="Ask MasalaPOS about these figures">
      <Icon name="sparkle" size={16} /><span>Ask AI</span>
    </button>
    <aside id="ask-panel" ref={panel} className="ask-panel" hidden={!open} aria-label="Ask MasalaPOS panel">
      <button type="button" className="ask-panel-close" aria-label="Close Ask MasalaPOS" onClick={() => setOpen(false)}>×</button>
      <AskMasalaPOS setup={setup} />
    </aside>
  </>;
}
