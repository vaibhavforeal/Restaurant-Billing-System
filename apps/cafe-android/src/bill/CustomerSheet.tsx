import { useState } from "react";
import { Text } from "react-native";
import { CustomerError, findCustomers, getCustomer, saveCustomer, type Customer } from "@masalapos/cafe-data";
import { useDb, useData } from "../db/provider";
import { color, type } from "../theme/tokens";
import { Banner, Button, Field, ListRow, Sheet } from "../ui";

/** Finds a customer by phone or name as you type, or adds one. `onPick` gets the chosen customer. */
export function CustomerSheet({ visible, onPick, onClose }: { visible: boolean; onPick: (c: Customer) => void; onClose: () => void }) {
  const db = useDb();
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", phone: "", addressNote: "" });
  const [error, setError] = useState<{ text: string; existingId?: string } | null>(null);
  const found = useData((d) => (visible && !adding ? findCustomers(d, query) : []));

  function reset() { setQuery(""); setAdding(false); setForm({ name: "", phone: "", addressNote: "" }); setError(null); }
  function close() { reset(); onClose(); }
  function pick(c: Customer) { reset(); onPick(c); }

  function startAdding() {
    const digits = query.replace(/\D/g, "");
    setForm({ name: digits.length >= 6 ? "" : query.trim(), phone: digits.length >= 6 ? query.trim() : "", addressNote: "" });
    setError(null);
    setAdding(true);
  }

  function save() {
    try {
      pick(saveCustomer(db, form, Date.now()));
    } catch (e) {
      if (e instanceof CustomerError) setError({ text: e.message, ...(e.existingId ? { existingId: e.existingId } : {}) });
      else setError({ text: "The customer could not be saved. Try again." });
    }
  }

  const existing = error?.existingId ? getCustomer(db, error.existingId) : null;

  return (
    <Sheet visible={visible} title={adding ? "Add customer" : "Customer"} onClose={close}
      footer={adding
        ? <Button label="Save customer" size="lg" onPress={save} />
        : <Button label="Add customer" icon="plus" variant="secondary" onPress={startAdding} />}>
      {adding ? (
        <>
          <Field label="Name" value={form.name} onChangeText={(name) => setForm({ ...form, name })} autoCapitalize="words" maxLength={60} autoFocus />
          <Field label="Mobile number" value={form.phone} onChangeText={(phone) => setForm({ ...form, phone })} keyboardType="phone-pad" maxLength={16} />
          <Field label="Address (optional)" help="Fills the delivery note on Delivery orders" value={form.addressNote}
            onChangeText={(addressNote) => setForm({ ...form, addressNote })} multiline maxLength={200} />
          {error ? <Banner tone="error" text={error.text} {...(existing ? { action: { label: `Use ${existing.name}`, onPress: () => pick(existing) } } : {})} /> : null}
          <Button label="Back to search" variant="quiet" onPress={() => setAdding(false)} />
        </>
      ) : (
        <>
          <Field label="Phone or name" value={query} onChangeText={setQuery} autoFocus placeholder="98765 or Asha" />
          {found.map((c) => <ListRow key={c.id} title={c.name} subtitle={c.phone} onPress={() => pick(c)} />)}
          {query.trim() && !found.length ? <Text style={[type.body, { color: color.onSurfaceMuted }]}>No customer matches. Add them below.</Text> : null}
        </>
      )}
    </Sheet>
  );
}
