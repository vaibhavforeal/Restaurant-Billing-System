import { Fragment, type ReactNode } from "react";
import { parseAiText, type Inline } from "./ai-markdown";

function inline(parts: Inline[]): ReactNode[] {
  return parts.map((part, i) => part.type === "text" ? <Fragment key={i}>{part.text}</Fragment>
    : part.type === "code" ? <code key={i}>{part.text}</code>
    : part.type === "strong" ? <strong key={i}>{inline(part.children)}</strong>
    : <em key={i}>{inline(part.children)}</em>);
}

/** An AI answer's light Markdown as React elements (never as HTML). */
export function AiText({ text, className }: { text: string; className?: string }) {
  return <div className={`ai-text${className ? ` ${className}` : ""}`}>{parseAiText(text).map((block, i) =>
    block.type === "h" ? <p key={i} className="ai-text-heading">{inline(block.inline)}</p>
    : block.type === "ul" ? <ul key={i}>{block.items.map((item, n) => <li key={n}>{inline(item)}</li>)}</ul>
    : block.type === "ol" ? <ol key={i} start={block.start}>{block.items.map((item, n) => <li key={n}>{inline(item)}</li>)}</ol>
    : <p key={i}>{block.lines.map((line, n) => <Fragment key={n}>{n > 0 && <br />}{inline(line)}</Fragment>)}</p>)}</div>;
}
