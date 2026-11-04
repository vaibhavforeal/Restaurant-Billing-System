import { RiAddLine } from "@remixicon/react";
import { Button } from "@board/components/base/buttons/button";
import { asIcon } from "./board-icons";

interface Props {
  editing: boolean;
  busy: boolean;
  /** The dashboard has reached its widget limit. */
  full: boolean;
  onCustomise(): void;
  onAdd(): void;
  onReset(): void;
  onCancel(): void;
  onSave(): void;
}

// h-11 is the 44px touch target; BoardUI's own button sizes are 32-36px.
const TOUCH = "h-11";

/** The dashboard's action row: Customise when viewing; Add, Reset, Cancel and Save while editing. */
export function EditToolbar({ editing, busy, full, onCustomise, onAdd, onReset, onCancel, onSave }: Props) {
  return <div className="dd-toolbar">
    {editing ? <>
      <p className="dd-edit-hint text-caption-1-regular text-text-secondary">Drag by the header. Nearby edges align automatically; hold Alt to move freely.</p>
      <Button variant="secondary" size="small" className={TOUCH} leadingIcon={asIcon(RiAddLine)} disabled={full || busy} title={full ? "Your dashboard is full" : undefined} onClick={onAdd}>Add widget</Button>
      <Button variant="secondary" size="small" className={TOUCH} disabled={busy} onClick={onReset}>Reset to default</Button>
      <Button variant="secondary" size="small" className={TOUCH} disabled={busy} onClick={onCancel}>Cancel</Button>
      <Button variant="primary" size="small" className={TOUCH} disabled={busy} onClick={onSave}>{busy ? "Saving…" : "Save"}</Button>
    </> : <Button variant="secondary" size="small" className={TOUCH} disabled={busy} onClick={onCustomise}>{busy ? "Loading…" : "Customise"}</Button>}
  </div>;
}
