import { useEffect, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes, type ReactNode } from "react";

export function Button({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={`pos-button ${className}`} {...props} />;
}
export function Input(props: InputHTMLAttributes<HTMLInputElement>) { return <input {...props} />; }
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) { return <select {...props} />; }
export function TerminalClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const timer = window.setInterval(() => setNow(new Date()), 30000); return () => window.clearInterval(timer); }, []);
  return <time className="pos-clock" dateTime={now.toISOString()} title="This device's date and time">{now.toLocaleDateString(undefined, { day: "2-digit", month: "short" })} · {now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</time>;
}
export function TableScroller({ children }: { children: ReactNode }) {
  return <div className="pos-table-scroll" tabIndex={0} role="region" aria-label="Scrollable records">{children}</div>;
}
export function SegmentedControl<T extends string>({ label, value, options, onChange, disabled = false }: {
  label: string; value: T; options: readonly { value: T; label: string }[]; onChange: (value: T) => void; disabled?: boolean;
}) {
  return <div className="pos-segments" role="group" aria-label={label}>{options.map((option) =>
    <Button key={option.value} disabled={disabled} aria-pressed={value === option.value} onClick={() => onChange(option.value)}>{option.label}</Button>
  )}</div>;
}
export function QtyStepper({ name, value, disabled, onChange }: { name: string; value: number; disabled: boolean; onChange: (value: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  function commit() {
    const next = Number(text);
    if (Number.isInteger(next) && next >= 1 && next <= 99) onChange(next);
    else setText(String(value));
  }
  return <div className="qty-stepper">
    <Button aria-label={`Decrease ${name}`} title={`Decrease ${name}`} disabled={disabled || value <= 1} onClick={() => onChange(value - 1)}>−</Button>
    <Input aria-label={`Quantity of ${name}`} title="Quantity (1–99). Enter to apply; Esc to cancel." inputMode="numeric" type="text" pattern="[0-9]*" maxLength={2} value={text} disabled={disabled}
      onFocus={(event) => event.target.select()} onChange={(event) => setText(event.target.value)} onBlur={commit}
      onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commit(); } if (event.key === "Escape") { event.preventDefault(); setText(String(value)); } }} />
    <Button aria-label={`Increase ${name}`} title={`Increase ${name}`} disabled={disabled || value >= 99} onClick={() => onChange(value + 1)}>+</Button>
  </div>;
}
export function OverflowMenu({ label = "More", children }: { label?: string; children: ReactNode }) {
  return <details className="pos-overflow" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}><summary>{label}</summary><div className="pos-overflow-content" onClick={(event) => {
    if ((event.target as HTMLElement).closest("button:not(:disabled)")) event.currentTarget.parentElement?.removeAttribute("open");
  }}>{children}</div></details>;
}
