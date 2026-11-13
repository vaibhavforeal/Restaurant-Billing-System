import { useState } from "react";
import { Alert, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { router } from "expo-router";
import { deleteCategory, listMenu, moveInList, saveCategory, setItemAvailable, type Category, type Item } from "@masalapos/cafe-data";
import { useDb, useData } from "../../db/provider";
import { menuErrorMessage } from "../../menu/errors";
import { formatRupees } from "../../money";
import { color, radius, space, touch, type } from "../../theme/tokens";
import { Banner, Button, Field, Icon, Screen, Sheet } from "../../ui";
import { useScreenGate } from "../../staff/useApproval";

const priceText = (item: Item) =>
  item.variants.length ? `from ${formatRupees(Math.min(...item.variants.map((v) => v.pricePaise)))}` : formatRupees(item.pricePaise);

function MoveButtons({ onUp, onDown, label }: { onUp: () => void; onDown: () => void; label: string }) {
  return (
    <View style={styles.move}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Move ${label} up`} onPress={onUp} style={styles.moveKey}><Icon name="up" /></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={`Move ${label} down`} onPress={onDown} style={styles.moveKey}><Icon name="down" /></Pressable>
    </View>
  );
}

/** Categories and items: add, edit, reorder, and the quick "not available today" switch. */
function MenuScreen() {
  const db = useDb();
  const menu = useData(listMenu);
  const [ordering, setOrdering] = useState(false);
  const [editing, setEditing] = useState<{ category: Category | null; name: string; error: string | null } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const attempt = (fn: () => void) => { try { fn(); setProblem(null); } catch (e) { setProblem(menuErrorMessage(e)); } };

  function saveEditing() {
    if (!editing) return;
    try {
      saveCategory(db, { ...(editing.category ? { id: editing.category.id } : {}), name: editing.name }, Date.now());
      setEditing(null);
    } catch (e) {
      setEditing({ ...editing, error: menuErrorMessage(e) });
    }
  }

  function confirmDeleteCategory(c: Category) {
    Alert.alert(`Delete ${c.name}?`, "The category is removed from the menu. Old bills are not changed.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => {
        try { deleteCategory(db, c.id, Date.now()); setEditing(null); } catch (e) { setEditing((x) => x && { ...x, error: menuErrorMessage(e) }); }
      } },
    ]);
  }

  return (
    <Screen
      title="Menu"
      actions={menu.items.length > 1 || menu.categories.length > 1
        ? <Button label={ordering ? "Done" : "Edit order"} variant={ordering ? "primary" : "secondary"} onPress={() => setOrdering(!ordering)} /> : null}
    >
      <View style={styles.actions}>
        <Button label="Add category" icon="plus" variant="secondary" onPress={() => setEditing({ category: null, name: "", error: null })} style={styles.grow} />
        <Button label="Add item" icon="plus" disabled={menu.categories.length === 0} onPress={() => router.push("/menu/item")} style={styles.grow} />
      </View>
      {problem ? <Banner tone="error" text={problem} /> : null}
      {menu.categories.length === 0 ? (
        <Text style={[type.body, { color: color.onSurfaceMuted }]}>No menu yet. Add a category such as "Hot drinks", then its items. You can bill any amount from Bill with Custom item meanwhile.</Text>
      ) : null}
      {menu.categories.map((c) => {
        const items = menu.items.filter((i) => i.categoryId === c.id);
        return (
          <View key={c.id} style={styles.section}>
            <View style={styles.sectionHeader}>
              <Pressable accessibilityRole="button" accessibilityLabel={`Rename or delete ${c.name}`} style={styles.sectionTitle}
                onPress={() => setEditing({ category: c, name: c.name, error: null })}>
                <Text style={[type.title, { color: color.onSurface }]} numberOfLines={1}>{c.name}</Text>
                <Text style={[type.caption, { color: color.onSurfaceMuted }]}>{items.length} {items.length === 1 ? "item" : "items"}</Text>
              </Pressable>
              {ordering ? <MoveButtons label={c.name} onUp={() => attempt(() => moveInList(db, "categories", c.id, "up", Date.now()))}
                onDown={() => attempt(() => moveInList(db, "categories", c.id, "down", Date.now()))} /> : null}
            </View>
            {items.map((item) => (
              <View key={item.id} style={styles.itemRow}>
                <Pressable accessibilityRole="button" accessibilityLabel={`Edit ${item.name}`} style={styles.itemText}
                  onPress={() => router.push({ pathname: "/menu/item", params: { id: item.id } })}>
                  <Text style={[type.bodyStrong, { color: item.available ? color.onSurface : color.onSurfaceMuted }]} numberOfLines={2}>{item.name}</Text>
                  <Text style={[type.small, { color: color.onSurfaceMuted }]}>{priceText(item)}{item.available ? "" : " · Not available today"}</Text>
                </Pressable>
                {ordering ? (
                  <MoveButtons label={item.name} onUp={() => attempt(() => moveInList(db, "items", item.id, "up", Date.now()))}
                    onDown={() => attempt(() => moveInList(db, "items", item.id, "down", Date.now()))} />
                ) : (
                  <View style={styles.switch}>
                    <Text style={[type.caption, { color: color.onSurfaceMuted }]}>Available</Text>
                    <Switch value={item.available} accessibilityLabel={`${item.name} available`}
                      trackColor={{ true: color.primary, false: color.outlineVariant }} thumbColor={color.surface}
                      onValueChange={(on) => attempt(() => setItemAvailable(db, item.id, on, Date.now()))} />
                  </View>
                )}
              </View>
            ))}
            {items.length === 0 ? <Text style={[type.small, styles.emptyCategory]}>No items in this category.</Text> : null}
          </View>
        );
      })}

      <Sheet visible={editing !== null} title={editing?.category ? "Rename category" : "Add category"} onClose={() => setEditing(null)}
        footer={<>
          <Button label="Save" size="lg" onPress={saveEditing} />
          {editing?.category ? <Button label="Delete category" variant="danger" onPress={() => confirmDeleteCategory(editing.category!)} /> : null}
        </>}>
        <Field label="Category name" value={editing?.name ?? ""} autoFocus maxLength={60} error={editing?.error ?? null}
          onChangeText={(name) => setEditing((x) => x && { ...x, name, error: null })} onSubmitEditing={saveEditing} />
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: "row", gap: space.sm },
  grow: { flex: 1 },
  section: { backgroundColor: color.surface, borderRadius: radius.md, borderWidth: 1, borderColor: color.outlineVariant, overflow: "hidden" },
  sectionHeader: { flexDirection: "row", alignItems: "center", paddingRight: space.xs, backgroundColor: color.surfaceVariant },
  sectionTitle: { flex: 1, minHeight: touch.large, justifyContent: "center", paddingHorizontal: space.md },
  itemRow: { flexDirection: "row", alignItems: "center", minHeight: touch.large + space.xs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.outlineVariant },
  itemText: { flex: 1, paddingHorizontal: space.md, paddingVertical: space.xs, minHeight: touch.large, justifyContent: "center" },
  switch: { alignItems: "center", paddingHorizontal: space.sm, minWidth: touch.min + space.md },
  move: { flexDirection: "row" },
  moveKey: { width: touch.min, height: touch.min, alignItems: "center", justifyContent: "center" },
  emptyCategory: { color: color.onSurfaceMuted, padding: space.md },
});

/** The menu needs a manager or the owner, asked once on entry. */
export default function MenuTab() {
  const { allowed, sheet } = useScreenGate("catalog.manage", "Open the menu");
  return <>{allowed ? <MenuScreen /> : <Screen title="Menu"><></></Screen>}{sheet}</>;
}
