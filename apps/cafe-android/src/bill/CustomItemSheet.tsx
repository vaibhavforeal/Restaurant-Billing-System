import { useState } from "react";
import { StyleSheet, Switch, Text, View } from "react-native";
import { listMenu, saveItem, type CafeSettings } from "@masalapos/cafe-data";
import { useDb, useData } from "../db/provider";
import { menuErrorMessage } from "../menu/errors";
import { parseRupees } from "../money";
import { color, space, type } from "../theme/tokens";
import { Banner, Button, Choice, Field, Keypad, Money, Sheet, pressKey } from "../ui";
import { cart } from "../cart/cart";

const RATES = [{ value: "default", label: "Cafe default" }, ...[0, 5, 12, 18, 28].map((r) => ({ value: String(r), label: `${r}%` }))];

/** Bills any amount without a menu item: a price on the keypad, an optional name, quantity and GST rate. */
export function CustomItemSheet({ visible, onClose, cafe, intro }: { visible: boolean; onClose: () => void; cafe: CafeSettings; intro?: string }) {
  const db = useDb();
  const categories = useData((d) => listMenu(d).categories);
  const [amount, setAmount] = useState("");
  const [name, setName] = useState("");
  const [qty, setQty] = useState(1);
  const [rate, setRate] = useState("default");
  const [saveToMenu, setSaveToMenu] = useState(false);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const pricePaise = parseRupees(amount);

  function reset() { setAmount(""); setName(""); setQty(1); setRate("default"); setSaveToMenu(false); setProblem(null); }

  function add() {
    if (pricePaise === null) return;
    const gstRate = rate === "default" ? null : Number(rate);
    const label = name.trim() || "Item";
    let itemId: string | null = null;
    if (saveToMenu) {
      const category = categoryId ?? categories[0]?.id;
      if (!category) return setProblem("Add a category in Menu first, or switch off Save to menu.");
      try {
        itemId = saveItem(db, { categoryId: category, name: label, pricePaise, gstRate, variants: [] }, Date.now()).id;
      } catch (e) {
        return setProblem(menuErrorMessage(e));
      }
    }
    cart.add({ itemId, variantId: null, name: label, pricePaise, gstRate });
    const added = cart.entries().at(-1);
    if (added && qty > 1) cart.setQty(added.key, added.qty - 1 + qty);
    reset();
    onClose();
  }

  return (
    <Sheet visible={visible} title="Custom item" onClose={() => { reset(); onClose(); }}
      footer={<Button label={pricePaise !== null ? "Add to bill" : "Enter a price"} size="lg" disabled={pricePaise === null} onPress={add} />}>
      {intro ? <Banner text={intro} /> : null}
      <View style={styles.amount} accessibilityLiveRegion="polite">
        {pricePaise !== null ? <Money paise={pricePaise * qty} size="display" /> : <Text style={[type.display, { color: color.disabled }]}>₹0</Text>}
        {qty > 1 && pricePaise !== null ? <Text style={[type.small, { color: color.onSurfaceMuted }]}>{qty} × ₹{amount}</Text> : null}
      </View>
      <Keypad onKey={(k) => setAmount((a) => pressKey(a, k))} />
      <Field label="Name (optional)" placeholder="Item" value={name} onChangeText={setName} maxLength={60} />
      <View style={styles.qty}>
        <Text style={[type.label, styles.grow, { color: color.onSurface }]}>Quantity</Text>
        <Button label="−" variant="secondary" onPress={() => setQty((q) => Math.max(1, q - 1))} />
        <Text style={[type.title, styles.qtyValue]}>{qty}</Text>
        <Button label="+" variant="secondary" onPress={() => setQty((q) => Math.min(999, q + 1))} />
      </View>
      {cafe.gstMode !== "none" ? <Choice label={`GST rate (cafe default ${cafe.defaultGstRate}%)`} options={RATES} value={rate} onChange={setRate} /> : null}
      <View style={styles.qty}>
        <Text style={[type.label, styles.grow, { color: color.onSurface }]}>Save to menu</Text>
        <Switch value={saveToMenu} onValueChange={setSaveToMenu} accessibilityLabel="Save to menu"
          trackColor={{ true: color.primary, false: color.outlineVariant }} thumbColor={color.surface} />
      </View>
      {saveToMenu && categories.length ? (
        <Choice label="Category" options={categories.map((c) => ({ value: c.id, label: c.name }))} value={categoryId ?? categories[0]!.id} onChange={setCategoryId} />
      ) : null}
      {problem ? <Banner tone="error" text={problem} /> : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  amount: { alignItems: "center", paddingVertical: space.xs },
  qty: { flexDirection: "row", alignItems: "center", gap: space.sm },
  qtyValue: { minWidth: 40, textAlign: "center", color: color.onSurface },
  grow: { flex: 1 },
});
