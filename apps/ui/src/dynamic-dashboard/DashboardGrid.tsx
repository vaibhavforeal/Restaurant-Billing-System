import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { GRID_COLUMNS, moveItem, resizeItem, stackOrder, widgetDef, type DashboardItemValue, type GridRect } from "@masalapos/domain/dashboard";
import { GAP_PX, ROW_HEIGHT_PX, cellFromPointer, keyboardChange } from "./grid-pointer";
import "./dynamic-dashboard.css";

interface Props {
  items: DashboardItemValue[];
  editing: boolean;
  narrow: boolean;
  onChange(items: DashboardItemValue[]): void;
  renderItem(item: DashboardItemValue): ReactNode;
  /** Settings and remove buttons. Shown only while editing. */
  renderTools(item: DashboardItemValue): ReactNode;
}

type Mode = "move" | "resize";

interface Gesture {
  key: string;
  mode: Mode;
  pointerId: number;
  startX: number;
  startY: number;
  pitch: number;
  start: GridRect;
}

/** What the layout would look like if the pointer were released now. */
interface Preview {
  key: string;
  items: DashboardItemValue[];
  rect: GridRect;
}

const rectOf = (i: GridRect): GridRect => ({ x: i.x, y: i.y, w: i.w, h: i.h });
const sameRect = (a: GridRect, b: GridRect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

function placement(r: GridRect): CSSProperties {
  return { gridColumn: `${r.x + 1} / span ${r.w}`, gridRow: `${r.y + 1} / span ${r.h}` };
}

export function DashboardGrid({ items, editing, narrow, onChange, renderItem, renderTools }: Props) {
  const gridRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);

  const apply = useCallback((item: DashboardItemValue, mode: Mode, target: { x: number; y: number } | { w: number; h: number }): DashboardItemValue[] => {
    const limits = widgetDef(item.widget).limits;
    return mode === "move"
      ? moveItem(items, item.key, target as { x: number; y: number }, limits)
      : resizeItem(items, item.key, target as { w: number; h: number }, limits);
  }, [items]);

  const cancel = useCallback(() => {
    gesture.current = null;
    setPreview(null);
  }, []);

  // Escape abandons a drag in progress.
  const dragging = preview !== null;
  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") cancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dragging, cancel]);

  if (narrow) {
    return (
      <div className="dd-stack">
        {stackOrder(items).map((item) => (
          <div key={item.key} className="dd-item" style={{ minHeight: item.h * ROW_HEIGHT_PX + (item.h - 1) * GAP_PX }}>
            <div className="dd-body">{renderItem(item)}</div>
          </div>
        ))}
      </div>
    );
  }

  const begin = (e: PointerEvent<HTMLElement>, item: DashboardItemValue, mode: Mode) => {
    if (!editing || (e.pointerType === "mouse" && e.button !== 0)) return;
    // Pointer distances are measured against the column pitch (one column plus its gap).
    const width = gridRef.current?.getBoundingClientRect().width ?? 0;
    if (!(width > 0)) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current = { key: item.key, mode, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, pitch: width / GRID_COLUMNS, start: rectOf(item) };
    setPreview({ key: item.key, items, rect: rectOf(item) });
  };

  const track = (e: PointerEvent<HTMLElement>) => {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    const item = items.find((i) => i.key === g.key);
    if (!item) return cancel();
    const target = cellFromPointer(e.clientX - g.startX, e.clientY - g.startY, g.pitch, g.start, g.mode);
    const next = apply(item, g.mode, target);
    const moved = next.find((i) => i.key === g.key);
    if (moved) setPreview({ key: g.key, items: next, rect: rectOf(moved) });
  };

  const finish = (e: PointerEvent<HTMLElement>) => {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    const result = preview;
    cancel();
    if (result && !sameRect(result.rect, g.start)) onChange(result.items);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>, item: DashboardItemValue) => {
    // Keys pressed inside a tool button belong to that button.
    if (!editing || e.target !== e.currentTarget) return;
    const change = keyboardChange(e.key, e.shiftKey, item);
    if (!change) return;
    const next = change.size ? apply(item, "resize", change.size) : change.move ? apply(item, "move", change.move) : null;
    const after = next?.find((i) => i.key === item.key);
    // Leave the key alone (so Tab and friends still work) unless something really changes.
    if (!next || !after || sameRect(after, item)) return;
    e.preventDefault();
    onChange(next);
  };

  return (
    <div ref={gridRef} className="dd-grid">
      {items.map((item) => {
        const def = widgetDef(item.widget);
        const active = preview?.key === item.key;
        return (
          <div
            key={item.key}
            className={`dd-item${editing ? " dd-item-editing" : ""}${active ? " dd-item-active" : ""}`}
            style={placement(item)}
            tabIndex={editing ? 0 : undefined}
            aria-label={editing ? `${def.title}, column ${item.x + 1}, row ${item.y + 1}, ${item.w} by ${item.h}` : undefined}
            onKeyDown={editing ? (e) => onKeyDown(e, item) : undefined}
          >
            {editing && (
              <div
                className="dd-handle"
                onPointerDown={(e) => begin(e, item, "move")}
                onPointerMove={track}
                onPointerUp={finish}
                onPointerCancel={cancel}
              >
                <span className="dd-handle-title">{def.title}</span>
                <span className="dd-tools" onPointerDown={(e) => e.stopPropagation()}>{renderTools(item)}</span>
              </div>
            )}
            <div className="dd-body">{renderItem(item)}</div>
            {editing && (
              <div
                className="dd-grip"
                aria-hidden="true"
                onPointerDown={(e) => begin(e, item, "resize")}
                onPointerMove={track}
                onPointerUp={finish}
                onPointerCancel={cancel}
              />
            )}
          </div>
        );
      })}
      {preview && <div className="dd-placeholder" aria-hidden="true" style={placement(preview.rect)} />}
    </div>
  );
}
