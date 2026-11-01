import { useEffect, useRef, useState } from "react";
import type { SearchHit } from "../../licensing-worker/src/portal/api-types";
import { api, query } from "./api";
import { Icon } from "./icons";
import { navigate } from "./router";

const KIND = { customer: "Customer", order: "Order", lead: "Lead", ticket: "Ticket" } as const;
const target = (hit: SearchHit) => `/${hit.kind}s/${hit.id}`;

/** Customers by name, phone, GSTIN or Customer ID, orders by Order ID; Enter opens the first. */
export function Search() {
  const [text, setText] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [selected, setSelected] = useState(0);
  const sequence = useRef(0);
  useEffect(() => {
    const term = text.trim();
    if (term.length < 2) { setHits(null); return; }
    const request = ++sequence.current;
    const timer = setTimeout(() => {
      api<{ hits: SearchHit[] }>(`/search${query({ q: term })}`).then((r) => { if (request === sequence.current) { setHits(r.hits); setSelected(0); } }).catch(() => undefined);
    }, 200);
    return () => clearTimeout(timer);
  }, [text]);
  const open = (hit: SearchHit) => { setText(""); setHits(null); navigate(target(hit)); };
  return <div className="search" role="search">
    <Icon name="search" />
    <input type="search" aria-label="Search customers and orders" placeholder="Search customers, phone, GSTIN, Customer or Order ID" value={text}
      onChange={(e) => setText(e.target.value)} onBlur={() => setTimeout(() => setHits(null), 150)}
      onKeyDown={(e) => {
        if (!hits?.length) return;
        if (e.key === "ArrowDown") { e.preventDefault(); setSelected((s) => Math.min(s + 1, hits.length - 1)); }
        if (e.key === "ArrowUp") { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); }
        if (e.key === "Enter") { e.preventDefault(); open(hits[selected]!); }
        if (e.key === "Escape") setHits(null);
      }} />
    {hits && <div className="search-results" role="listbox">
      {hits.length === 0 ? <p className="muted" style={{ padding: "8px 10px" }}>Nothing matches “{text.trim()}”.</p>
        : hits.map((hit, i) => <a key={`${hit.kind}:${hit.id}`} href={`/portal${target(hit)}`} role="option" aria-selected={i === selected}
          onMouseDown={(e) => { e.preventDefault(); open(hit); }}><span><strong>{hit.title}</strong> <span className="muted">{hit.detail}</span></span><span className="kind">{KIND[hit.kind]}</span></a>)}
    </div>}
  </div>;
}
