import { useState } from "react";
import { CounterSettingsInput, getCounterSettings, LOCK_MINUTES, saveCounterSettings } from "@masalapos/cafe-data";
import { useDb } from "../../db/provider";
import { parseAmountPaise } from "../../payment/tender";
import { useApproval } from "../../staff/useApproval";
import { Banner, Button, Choice, Field, Screen } from "../../ui";

const LOCK_OPTIONS = LOCK_MINUTES.map((m) => ({ value: m, label: m === 0 ? "Never" : `${m} min` }));
const SERVED_BY = [{ value: "no", label: "No" }, { value: "yes", label: "Yes" }] as const;

/** The cashier's discount limit, the idle lock and whether receipts name who served. Saving asks for the owner PIN. */
export default function CounterSettingsScreen() {
  const db = useDb();
  const { approve, sheet } = useApproval();
  const [initial] = useState(() => getCounterSettings(db));
  const [limit, setLimit] = useState(String(initial.cashierDiscountBp / 100));
  const [lock, setLock] = useState<number>(initial.lockAfterMinutes);
  const [servedBy, setServedBy] = useState<"yes" | "no">(initial.showServedBy ? "yes" : "no");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // The percent field takes up to two decimals, like an amount: "5" is 500 basis points, "2.5" is 250.
  const bp = parseAmountPaise(limit);

  async function save() {
    setSaved(false);
    const input = { ...getCounterSettings(db), cashierDiscountBp: bp ?? -1, lockAfterMinutes: lock, showServedBy: servedBy === "yes" };
    const parsed = CounterSettingsInput.safeParse(input);
    if (bp === null || !parsed.success) { setError("Enter a limit from 0 to 100 percent"); return; }
    const by = await approve("settings.manage", { title: "Save counter settings", always: true });
    if (!by) return;
    saveCounterSettings(db, parsed.data, Date.now());
    setError(null);
    setSaved(true);
  }

  return (
    <Screen title="Counter" edges={["top", "bottom"]}>
      <Field label="Cashier discount limit (%)" help="A cashier can give up to this much off a bill. More needs a manager's or the owner's PIN."
        value={limit} onChangeText={(t) => { setLimit(t); setSaved(false); }} keyboardType="decimal-pad" placeholder="5" error={error} />
      <Choice label="Lock the till after no touch for" options={LOCK_OPTIONS} value={lock} onChange={(v) => { setLock(v); setSaved(false); }} />
      <Choice label="Print who served on the receipt" options={SERVED_BY} value={servedBy} onChange={(v) => { setServedBy(v); setSaved(false); }} />
      {saved ? <Banner tone="success" text="Saved." /> : null}
      <Button label="Save" size="lg" onPress={() => void save()} accessibilityHint="Asks for the owner PIN" />
      {sheet}
    </Screen>
  );
}
