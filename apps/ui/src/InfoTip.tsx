import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./info-tip.css";

/** Optional help, available to mouse, keyboard and touch users. */
export function InfoTip({ children, id, label = "More information" }: { children: ReactNode; id?: string; label?: string }) {
  const generatedId = useId();
  const descriptionId = id ?? generatedId;
  const trigger = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });

  useLayoutEffect(() => {
    if (!open || !trigger.current || !bubble.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const height = bubble.current.getBoundingClientRect().height;
    setPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - bubble.current.offsetWidth - 8)),
      top: rect.bottom + height < window.innerHeight - 8 ? rect.bottom : Math.max(8, rect.top - height),
    });
    const close = () => setOpen(false);
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); close(); } };
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);

  return <span className="info-tip" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
    <span ref={trigger} role="button" tabIndex={0} className="info-tip-trigger" aria-label={label} aria-describedby={descriptionId}
      onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); setOpen(true); } }}
      onClick={(event) => { event.preventDefault(); event.stopPropagation(); setOpen(true); }}>i</span>
    {createPortal(<span ref={bubble} id={descriptionId} role="tooltip" className="info-tip-bubble" hidden={!open}
      style={position}>{children}</span>, document.body)}
  </span>;
}
