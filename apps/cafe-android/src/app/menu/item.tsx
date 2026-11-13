import { useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { deleteItem, listMenu, saveItem } from "@masalapos/cafe-data";
import { useDb, useData } from "../../db/provider";
import { menuErrorMessage } from "../../menu/errors";
import { hasUnprintable } from "../../menu/printable";
import { parseRupees } from "../../money";
import { color, space, touch, type } from "../../theme/tokens";
import { Banner, Button, Choice, Field, Icon, Screen } from "../../ui";
import { useScreenGate } from "../../staff/useApproval";

const RATES = [{ value: "default", label: "Cafe default" }, ...[0, 5, 12, 18, 28].map((r) => ({ value: String(r), label: `${r}%` }))];
const rupees = (paise: number) => (paise / 100).toFixed(2).replace(/\.00$/, "");
const UNPRINTABLE = "Receipts print English letters and numbers only. Other characters will print as ?";

/** Add or edit one item: name, category, price or variants, and GST rate. */
function ItemScreen() {
  const db = useDb();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const menu = useData(listMenu);
  const existing = id ? menu.items.find((i) => i.id === id) : undefined;
  const [name, setName] = useState(existing?.name ?? "");
  const [categoryId, setCategoryId] = useState(existing?.categoryId ?? menu.categories[0]?.id ?? "");
  const [price, setPrice] = useState(existing ? rupees(existing.pricePaise) : "");
  const [rate, setRate] = useState(existing?.gstRate === null || existing === undefined ? "default" : String(existing.gstRate));
  const [variants, setVariants] = useState(existing?.variants.map((v) => ({ id: v.id as string | undefined, name: v.name, price: rupees(v.pricePaise) })) ?? []);
  const [problem, setProblem] = useState<string | null>(null);

  function save() {
    const parsedVariants = variants.map((v) => ({ ...(v.id ? { id: v.id } : {}), name: v.name, pricePaise: parseRupees(v.price) }));
    const basePaise = variants.length ? 0 : parseRupees(price);
    if (basePaise === null || parsedVariants.some((v) => v.pricePaise === null)) return setProblem("Enter each price in rupees, such as 20 or 12.50.");
    try {
      saveItem(db, { ...(id ? { id } : {}), categoryId, name, pricePaise: basePaise, gstRate: rate === "default" ? null : Number(rate),
        variants: parsedVariants.map((v) => ({ ...v, pricePaise: v.pricePaise! })) }, Date.now());
      router.back();
    } catch (e) {
      setProblem(menuErrorMessage(e));
    }
  }

  function remove() {
    if (!id) return;
    Alert.alert(`Delete ${existing?.name ?? "this item"}?`, "It leaves the menu. Old bills keep their own copy.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => { try { deleteItem(db, id, Date.now()); router.back(); } catch (e) { setProblem(menuErrorMessage(e)); } } },
    ]);
  }

  const setVariant = (i: number, change: Partial<{ name: string; price: string }>) =>
    setVariants((vs) => vs.map((v, j) => (j === i ? { ...v, ...change } : v)));

  return (
    <Screen title={existing ? "Edit item" : "Add item"} edges={["top", "bottom"]}
      actions={<Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={styles.iconKey}><Icon name="close" /></Pressable>}>
      <Field label="Name" value={name} onChangeText={setName} maxLength={60} autoCapitalize="words"
        help={hasUnprintable(name) ? UNPRINTABLE : null} />
      {hasUnprintable(name) ? <Banner tone="warning" text={UNPRINTABLE} /> : null}
      <Choice label="Category" options={menu.categories.map((c) => ({ value: c.id, label: c.name }))} value={categoryId} onChange={setCategoryId} />
      {variants.length === 0 ? (
        <Field label="Price (₹)" value={price} onChangeText={setPrice} keyboardType="decimal-pad" placeholder="20" />
      ) : null}
      <Choice label="GST rate" options={RATES} value={rate} onChange={setRate} />

      <View style={styles.variants}>
        <Text style={[type.label, { color: color.onSurface }]}>Sizes or variants</Text>
        <Text style={[type.small, { color: color.onSurfaceMuted }]}>Such as Small and Large. With variants, the cashier picks one and its price is used.</Text>
        {variants.map((v, i) => (
          <View key={v.id ?? `new-${i}`} style={styles.variantRow}>
            <View style={styles.grow}><Field label="Variant" value={v.name} onChangeText={(t) => setVariant(i, { name: t })} maxLength={60}
              help={hasUnprintable(v.name) ? UNPRINTABLE : null} /></View>
            <View style={styles.price}><Field label="Price (₹)" value={v.price} onChangeText={(t) => setVariant(i, { price: t })} keyboardType="decimal-pad" /></View>
            <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${v.name || "variant"}`} style={styles.iconKey}
              onPress={() => setVariants((vs) => vs.filter((_, j) => j !== i))}><Icon name="close" tint={color.error} /></Pressable>
          </View>
        ))}
        <Button label="Add variant" icon="plus" variant="quiet" onPress={() => setVariants((vs) => [...vs, { id: undefined, name: "", price: "" }])} />
      </View>

      {problem ? <Banner tone="error" text={problem} /> : null}
      <Button label="Save" size="lg" onPress={save} disabled={!categoryId} />
      {existing ? <Button label="Delete item" variant="danger" onPress={remove} /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  variants: { gap: space.sm },
  variantRow: { flexDirection: "row", alignItems: "flex-end", gap: space.xs },
  grow: { flex: 1 },
  price: { width: 112 },
  iconKey: { width: touch.min, height: touch.min, alignItems: "center", justifyContent: "center" },
});

/** Adding or editing an item needs a manager or the owner, like the Menu tab; an approval given there carries over. */
export default function ItemRoute() {
  const { allowed, sheet } = useScreenGate("catalog.manage", "Edit the menu");
  return <>{allowed ? <ItemScreen /> : <Screen title="Item"><></></Screen>}{sheet}</>;
}
