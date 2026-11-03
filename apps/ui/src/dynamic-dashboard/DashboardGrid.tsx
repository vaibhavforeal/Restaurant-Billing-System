import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { GRID_COLUMNS, moveItem, resizeItem, stackOrder, widgetDef, type DashboardItemValue, type GridRect } from "@masalapos/domain/dashboard";
import { EDIT_ROW_HEIGHT_PX, GAP_PX, ROW_HEIGHT_PX, alignRect, cellFromPointer, keyboardChange } from "./grid-pointer";
import { cx } from "@board/utils/cx";
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

/** The BoardUI card surface every widget sits on. */
const CARD = "dd-item bg-background-primary-default border border-border-button-default rounded-2xl text-text-primary shadow-xs";

type Mode = "move" | "resize";

interface Gesture {
  key: string;
  mode: Mode;
  pointerId: number;
  startX: number;
  startY: number;
  pitch: number;
  canvasTop: number;
  canvasLeft: number;
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

function placement(r: GridRect, rowHeight: number): CSSProperties {
  return {
    left: `calc(${r.x / GRID_COLUMNS * 100}% + ${r.x / GRID_COLUMNS * GAP_PX}px)`,
    width: `calc(${r.w / GRID_COLUMNS * 100}% - ${(1 - r.w / GRID_COLUMNS) * GAP_PX}px)`,
    top: r.y * (rowHeight + GAP_PX),
    height: r.h * (rowHeight + GAP_PX) - GAP_PX,
  };
}

export function DashboardGrid({ items, editing, narrow, onChange, renderItem, renderTools }: Props) {
  const gridRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const rowHeight = editing ? EDIT_ROW_HEIGHT_PX : ROW_HEIGHT_PX;

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

  // Leaving edit mode or switching to the narrow layout mid-drag clears the preview, placeholder and faded state.
  useEffect(() => { cancel(); }, [editing, narrow, cancel]);

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
          <div key={item.key} className={CARD} style={{ minHeight: item.h * ROW_HEIGHT_PX + (item.h - 1) * GAP_PX }}>
            <div className="dd-body">{renderItem(item)}</div>
          </div>
        ))}
      </div>
    );
  }

  const begin = (e: PointerEvent<HTMLElement>, item: DashboardItemValue, mode: Mode) => {
    // A second finger cannot take over a drag that is already running.
    if (!editing || gesture.current || (e.pointerType === "mouse" && e.button !== 0)) return;
    // Pointer distances are measured against the column pitch (one column plus its gap).
    const canvas = gridRef.current?.getBoundingClientRect();
    if (!canvas || !(canvas.width > 0)) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current = { key: item.key, mode, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, pitch: (canvas.width + GAP_PX) / GRID_COLUMNS, canvasTop: canvas.top, canvasLeft: canvas.left, start: rectOf(item) };
    setPreview({ key: item.key, items, rect: rectOf(item) });
  };

  const previewAt = (e: PointerEvent<HTMLElement>): Preview | null => {
    const g = gesture.current;
    const canvas = gridRef.current?.getBoundingClientRect();
    if (!g || g.pointerId !== e.pointerId || !canvas) return null;
    const item = items.find((i) => i.key === g.key);
    if (!item) return null;
    const target = cellFromPointer(e.clientX - g.startX + g.canvasLeft - canvas.left, e.clientY - g.startY + g.canvasTop - canvas.top, g.pitch, g.start, g.mode, EDIT_ROW_HEIGHT_PX);
    const raw = { ...g.start, ...target };
    const aligned = e.altKey || sameRect(raw, g.start) ? raw : alignRect(raw, items.filter((i) => i.key !== g.key), g.mode, { x: g.pitch, y: EDIT_ROW_HEIGHT_PX + GAP_PX }, widgetDef(item.widget).limits);
    const next = apply(item, g.mode, aligned);
    const moved = next.find((i) => i.key === g.key);
    return moved ? { key: g.key, items: next, rect: rectOf(moved) } : null;
  };
  const track = (e: PointerEvent<HTMLElement>) => { if (gesture.current?.pointerId === e.pointerId) setPreview(previewAt(e)); };

  const finish = (e: PointerEvent<HTMLElement>) => {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    const result = previewAt(e);
    cancel();
    if (result && !sameRect(result.rect, g.start)) onChange(result.items);
  };

  /** A cancelled or lost pointer only ends the gesture it started; another finger's event is ignored. */
  const abandon = (e: PointerEvent<HTMLElement>) => {
    if (gesture.current?.pointerId === e.pointerId) cancel();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>, item: DashboardItemValue) => {
    // Keys pressed inside a tool button belong to that button.
    if (!editing || e.target !== e.currentTarget) return;
    const width = gridRef.current?.getBoundingClientRect().width ?? 0;
    if (width <= 0) return;
    const pixels = e.altKey ? 1 : 8;
    const change = keyboardChange(e.key, e.shiftKey, item, { x: pixels / ((width + GAP_PX) / GRID_COLUMNS), y: pixels / (rowHeight + GAP_PX) });
    if (!change) return;
    const next = change.size ? apply(item, "resize", change.size) : change.move ? apply(item, "move", change.move) : null;
    const after = next?.find((i) => i.key === item.key);
    // Leave the key alone (so Tab and friends still work) unless something really changes.
    if (!next || !after || sameRect(after, item)) return;
    e.preventDefault();
    onChange(next);
  };

  const shown = preview?.items ?? items;
  const canvasHeight = Math.max(0, ...shown.map((item) => (item.y + item.h) * (rowHeight + GAP_PX) - GAP_PX));
  return (
    <div ref={gridRef} className="dd-grid" style={{ height: canvasHeight }}>
      {items.map((item) => {
        const def = widgetDef(item.widget);
        const active = preview?.key === item.key;
        return (
          <div
            key={item.key}
            className={cx(CARD, editing && "dd-item-editing", active && "dd-item-active")}
            style={placement(shown.find((shownItem) => shownItem.key === item.key) ?? item, rowHeight)}
            tabIndex={editing ? 0 : undefined}
            aria-label={editing ? `${def.title}. Arrow keys move; Shift plus arrows resize; Alt makes fine adjustments.` : undefined}
            onKeyDown={editing ? (e) => onKeyDown(e, item) : undefined}
          >
            {editing && (
              <div
                className="dd-handle"
                onPointerDown={(e) => begin(e, item, "move")}
                onPointerMove={track}
                onPointerUp={finish}
                onPointerCancel={abandon}
                onLostPointerCapture={abandon}
              >
                <span className="dd-handle-title"><span className="dd-drag-icon" aria-hidden="true">⠿</span>{def.title}</span>
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
                onPointerCancel={abandon}
                onLostPointerCapture={abandon}
              />
            )}
          </div>
        );
      })}
      {preview && <div className="dd-placeholder" aria-hidden="true" style={placement(preview.rect, rowHeight)} />}
    </div>
  );
}
