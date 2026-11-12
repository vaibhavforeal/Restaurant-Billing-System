import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { getCafe, lastBillAt, listMenu, type Item } from "@masalapos/cafe-data";
import { CartPanel } from "../../bill/CartPanel";
import { CustomItemSheet } from "../../bill/CustomItemSheet";
import { VariantSheet } from "../../bill/VariantSheet";
import { cart, cartTotals, useCart } from "../../cart/cart";
import { useDb, useData } from "../../db/provider";
import { color, radius, space, touch, type } from "../../theme/tokens";
import { Banner, Button, Icon, Money, Tile, useLayout } from "../../ui";

const ALL = "all";
const lowest = (item: Item) => (item.variants.length ? Math.min(...item.variants.map((v) => v.pricePaise)) : item.pricePaise);

/** Billing: categories, item tiles and search on one side, the cart on the other (or in a sheet on a phone). */
export default function BillScreen() {
  const db = useDb();
  const snap = useCart();
  const { tablet, width } = useLayout();
  const cafe = useData(getCafe)!;
  const menu = useData(listMenu);
  const lastAt = useData(lastBillAt);
  const priced = useData((d) => cartTotals(d, snap));
  const [categoryId, setCategoryId] = useState(ALL);
  const [search, setSearch] = useState("");
  const [variantItem, setVariantItem] = useState<Item | null>(null);
  const [customOpen, setCustomOpen] = useState(menu.items.length === 0);
  const [cartOpen, setCartOpen] = useState(false);

  const query = search.trim().toLowerCase();
  const items = menu.items.filter((i) => (categoryId === ALL || i.categoryId === categoryId) && (!query || i.name.toLowerCase().includes(query)));
  const columns = Math.max(2, Math.floor(((tablet ? width - 380 - 96 : width) - space.md * 2) / 150));
  const tileWidth = `${100 / columns}%` as const;
  const lineCount = snap.lines.reduce((n, l) => n + l.qty, 0);

  function tap(item: Item) {
    if (item.variants.length) return setVariantItem(item);
    cart.add({ itemId: item.id, variantId: null, name: item.name, pricePaise: item.pricePaise, gstRate: item.gstRate });
  }
  const charge = () => { setCartOpen(false); router.push("/payment"); };

  const menuArea = (
    <View style={styles.menu}>
      <View style={styles.searchRow}>
        <View style={styles.search}>
          <Icon name="search" size={20} tint={color.onSurfaceMuted} />
          <TextInput value={search} onChangeText={setSearch} placeholder="Search items" placeholderTextColor={color.onSurfaceMuted}
            style={[type.body, styles.searchInput]} accessibilityLabel="Search items" />
        </View>
        <Button label="Custom item" icon="plus" variant="secondary" onPress={() => setCustomOpen(true)} />
      </View>
      {lastAt !== null && lastAt > Date.now() ? (
        <Banner tone="warning" text="This phone's clock is behind your last bill. Check the date and time." />
      ) : null}
      {menu.categories.length > 1 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.railScroll} contentContainerStyle={styles.rail}>
          {[{ id: ALL, name: "All" }, ...menu.categories].map((c) => {
            const on = c.id === categoryId;
            return (
              <Pressable key={c.id} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => setCategoryId(c.id)}
                style={[styles.chip, on && styles.chipOn]}>
                <Text style={[type.label, { color: on ? color.onPrimaryContainer : color.onSurface }]}>{c.name}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
      <ScrollView contentContainerStyle={styles.grid}>
        {items.map((item) => (
          <View key={item.id} style={[styles.cell, { width: tileWidth }]}>
            <Tile name={item.name} pricePaise={lowest(item)} fromPrice={item.variants.length > 0} disabled={!item.available} onPress={() => tap(item)} />
          </View>
        ))}
        {menu.items.length > 0 && items.length === 0 ? <Text style={[type.body, styles.none]}>No items match.</Text> : null}
        {menu.items.length === 0 ? <Text style={[type.body, styles.none]}>No menu yet. Bill any amount with Custom item, or add items in Menu.</Text> : null}
      </ScrollView>
    </View>
  );

  return (
    <SafeAreaView style={styles.fill} edges={["top"]}>
      {tablet ? (
        <View style={styles.split}>
          {menuArea}
          <View style={styles.side}><CartPanel cafe={cafe} priced={priced} onCharge={charge} /></View>
        </View>
      ) : (
        <>
          {menuArea}
          <View style={styles.bar}>
            <Pressable accessibilityRole="button" accessibilityLabel={`Cart, ${lineCount} items`} onPress={() => setCartOpen(true)} style={styles.barCart}>
              <Text style={[type.label, { color: color.onSurface }]}>{lineCount ? `${lineCount} ${lineCount === 1 ? "item" : "items"}` : "Cart empty"}</Text>
              {priced?.ok ? <Money paise={priced.totals.totalPaise} size="title" /> : <Text style={[type.small, { color: color.onSurfaceMuted }]}>View cart</Text>}
            </Pressable>
            <Button label="Charge" size="lg" disabled={!priced?.ok} onPress={charge} style={styles.barCharge} />
          </View>
          <Modal visible={cartOpen} transparent animationType="slide" onRequestClose={() => setCartOpen(false)} statusBarTranslucent>
            <Pressable style={styles.scrim} onPress={() => setCartOpen(false)} accessibilityLabel="Close cart" />
            <View style={styles.cartSheet}>
              <View style={styles.cartHeader}>
                <Text style={[type.title, { flex: 1, color: color.onSurface }]}>Cart</Text>
                {lineCount ? <Button label="Clear" variant="quiet" onPress={() => cart.clear()} /> : null}
                <Pressable accessibilityRole="button" accessibilityLabel="Close cart" onPress={() => setCartOpen(false)} style={styles.close}><Icon name="close" /></Pressable>
              </View>
              <CartPanel cafe={cafe} priced={priced} onCharge={charge} compact />
            </View>
          </Modal>
        </>
      )}
      <VariantSheet item={variantItem} onClose={() => setVariantItem(null)}
        onPick={(item, variantId) => {
          const v = item.variants.find((x) => x.id === variantId)!;
          cart.add({ itemId: item.id, variantId, name: `${item.name} (${v.name})`, pricePaise: v.pricePaise, gstRate: item.gstRate });
          setVariantItem(null);
        }} />
      <CustomItemSheet visible={customOpen} cafe={cafe} onClose={() => setCustomOpen(false)}
        {...(menu.items.length === 0 ? { intro: "No menu yet. Enter a price to make your first bill." } : {})} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: color.background },
  split: { flex: 1, flexDirection: "row" },
  side: { width: 380, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: color.outlineVariant },
  menu: { flex: 1, paddingTop: space.sm, gap: space.xs },
  searchRow: { flexDirection: "row", gap: space.sm, paddingHorizontal: space.md },
  search: { flex: 1, flexDirection: "row", alignItems: "center", gap: space.xs, minHeight: touch.min, paddingHorizontal: space.sm,
    borderRadius: radius.pill, backgroundColor: color.surface, borderWidth: 1, borderColor: color.outlineVariant },
  searchInput: { flex: 1, color: color.onSurface, paddingVertical: 0 },
  railScroll: { flexGrow: 0 },
  rail: { gap: space.xs, paddingHorizontal: space.md, paddingVertical: space.xxs },
  chip: { minHeight: touch.min, paddingHorizontal: space.md, borderRadius: radius.pill, justifyContent: "center", backgroundColor: color.surface,
    borderWidth: 1, borderColor: color.outlineVariant },
  chipOn: { backgroundColor: color.primaryContainer, borderColor: color.primary },
  grid: { flexDirection: "row", flexWrap: "wrap", paddingHorizontal: space.md - space.xxs, paddingBottom: space.lg },
  cell: { padding: space.xxs },
  none: { color: color.onSurfaceMuted, padding: space.md },
  bar: { flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.sm, backgroundColor: color.surface,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.outlineVariant },
  barCart: { flex: 1, minHeight: touch.large, justifyContent: "center", paddingHorizontal: space.xs },
  barCharge: { minWidth: 160 },
  scrim: { flex: 1, backgroundColor: color.scrim },
  cartSheet: { height: "78%", backgroundColor: color.surface, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, overflow: "hidden" },
  cartHeader: { flexDirection: "row", alignItems: "center", paddingLeft: space.md, paddingTop: space.xs },
  close: { width: touch.min, height: touch.min, alignItems: "center", justifyContent: "center" },
});
