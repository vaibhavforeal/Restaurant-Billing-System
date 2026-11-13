import { useState } from "react";
import { Alert, Text } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { CustomerError, deleteCustomer, getCustomer, listBillsForCustomer, saveCustomer } from "@masalapos/cafe-data";
import { useDb, useData } from "../../db/provider";
import { clockTime, deviceOffset, longDate } from "../../dates";
import { color, type } from "../../theme/tokens";
import { Banner, Button, Field, ListRow, Money, Screen } from "../../ui";

/** One customer: edit, delete, and their bills newest first. `new` adds one. */
export default function CustomerDetail() {
  const db = useDb();
  const { id } = useLocalSearchParams<{ id: string }>();
  const isNew = id === "new";
  const [existing] = useState(() => (isNew ? null : getCustomer(db, id)));
  const bills = useData((d) => (isNew ? [] : listBillsForCustomer(d, id)));
  const [form, setForm] = useState({ name: existing?.name ?? "", phone: existing?.phone ?? "", addressNote: existing?.addressNote ?? "" });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (!isNew && !existing) {
    return <Screen title="Customer"><Banner tone="error" text="This customer was deleted." /><Button label="Back" onPress={() => router.back()} /></Screen>;
  }

  function save() {
    try {
      const c = saveCustomer(db, { ...(existing ? { id: existing.id } : {}), ...form }, Date.now());
      setError(null);
      if (isNew) router.replace(`/customer/${c.id}`);
      else setSaved(true);
    } catch (e) {
      setError(e instanceof CustomerError ? e.message : "The customer could not be saved. Try again.");
    }
  }

  function remove() {
    if (!existing) return;
    Alert.alert(`Delete ${existing.name}?`, "Their old bills keep the name printed on them.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => { deleteCustomer(db, existing.id, Date.now()); router.back(); } },
    ]);
  }

  const edit = (key: keyof typeof form) => (value: string) => { setForm({ ...form, [key]: value }); setSaved(false); };

  return (
    <Screen title={isNew ? "Add customer" : existing!.name} edges={["top", "bottom"]}>
      <Field label="Name" value={form.name} onChangeText={edit("name")} autoCapitalize="words" maxLength={60} />
      <Field label="Mobile number" value={form.phone} onChangeText={edit("phone")} keyboardType="phone-pad" maxLength={16} />
      <Field label="Address (optional)" value={form.addressNote} onChangeText={edit("addressNote")} multiline maxLength={200} />
      {error ? <Banner tone="error" text={error} /> : null}
      {saved ? <Banner tone="success" text="Saved." /> : null}
      <Button label="Save" size="lg" onPress={save} />
      {existing ? <Button label="Delete customer" variant="danger" onPress={remove} /> : null}
      {existing ? <Text style={[type.title, { color: color.onSurface }]} accessibilityRole="header">Bills</Text> : null}
      {existing && !bills.length ? <Text style={[type.body, { color: color.onSurfaceMuted }]}>No bills yet.</Text> : null}
      {bills.map((b) => (
        <ListRow key={b.id} title={`${b.invoiceNo}${b.voided ? " · VOID" : ""}`}
          subtitle={`${longDate(b.businessDate)}, ${clockTime(b.createdAt, deviceOffset(b.createdAt))}`}
          trailing={<Money paise={b.totalPaise} size="small" />} onPress={() => router.push(`/bill/${b.id}`)} />
      ))}
    </Screen>
  );
}
