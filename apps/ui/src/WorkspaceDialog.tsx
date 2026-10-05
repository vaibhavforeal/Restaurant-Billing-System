import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./workspace-dialog.css";

export function WorkspaceDialog({ open, title, onClose, busy = false, children, className = "" }: {
  open: boolean;
  title: string;
  onClose: () => void;
  busy?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      element.showModal();
      heading.current?.focus();
    } else if (!open && element.open) element.close();
  }, [open]);

  return createPortal(<dialog ref={dialog} className={`workspace-dialog ${className}`} aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <header className="workspace-dialog-header">
      <h2 ref={heading} tabIndex={-1} id={titleId}>{title}</h2>
      <button disabled={busy} aria-label={`Close ${title}`} onClick={() => { if (!busy) onClose(); }}>Close</button>
    </header>
    <div className="workspace-dialog-body">{children}</div>
  </dialog>, document.body);
}
