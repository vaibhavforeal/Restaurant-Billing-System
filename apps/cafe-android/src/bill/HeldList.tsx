import { Alert, StyleSheet, Text, View } from "react-native";
import { deleteHeld, holdCart, listHeld, takeHeld, type HeldSummary } from "@masalapos/cafe-data";
import { uuidv7 } from "@masalapos/domain/id";
import { cart, entriesFromHeld } from "../cart/cart";
import { useDb, useData } from "../db/provider";
import { deviceOffset, heldAge } from "../dates";
import { session } from "../staff/session";
import { color, space, type } from "../theme/tokens";
import { Button, Sheet } from "../ui";

/** Held carts, oldest first. Opening one removes it from the list and loads it; `onOpened` gets what changed meanwhile. */
export function HeldList({ visible, onClose, onOpened }: {
  visible: boolean; onClose: () => void; onOpened: (notice: string | null) => void;
}) {
  const db = useDb();
  const held = useData((d) => (visible ? listHeld(d) : []));
  const now = Date.now();

  function open(h: HeldSummary) {
    const taken = takeHeld(db, h.id);
    if (!taken) { onOpened("That held order could not be read, so it was removed."); onClose(); return; }
    const rebuilt = entriesFromHeld(db, taken);
    cart.load(taken, rebuilt.entries, rebuilt.customer);
    const notes = [
      rebuilt.missing.length ? `Removed: ${rebuilt.missing.join(", ")} — no longer on the menu.` : "",
      rebuilt.customerMissing ? "The customer was deleted." : "",
    ].filter(Boolean);
    onOpened(notes.length ? notes.join(" ") : null);
    onClose();
  }

  function choose(h: HeldSummary) {
    if (!cart.entries().length) return open(h);
    Alert.alert("The cart has items", "Hold the current order first, then open this one?", [
      { text: "Cancel", style: "cancel" },
      { text: "Hold this one and open", onPress: () => {
        holdCart(db, { id: uuidv7(), cart: cart.toHeld(), note: "", staffId: session.get().staff?.id ?? null, now: Date.now() });
        cart.clear();
        open(h);
      } },
    ]);
  }

  function remove(h: HeldSummary) {
    Alert.alert("Delete this held order?", h.note || `${h.lineCount} ${h.lineCount === 1 ? "line" : "lines"}`, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => deleteHeld(db, h.id) },
    ]);
  }

  return (
    <Sheet visible={visible} title="Held orders" onClose={onClose}>
      {!held.length ? <Text style={[type.body, { color: color.onSurfaceMuted }]}>No held orders.</Text> : null}
      {held.map((h) => (
        <View key={h.id} style={styles.row}>
          <View style={styles.grow}>
            <Text style={[type.bodyStrong, { color: color.onSurface }]} numberOfLines={1}>{h.note || "Held order"}</Text>
            <Text style={[type.caption, { color: color.onSurfaceMuted }]}>
              {[`${h.lineCount} ${h.lineCount === 1 ? "line" : "lines"}`, h.staffName, heldAge(h.createdAt, now, deviceOffset(now))].filter(Boolean).join(" · ")}
            </Text>
          </View>
          <Button label="Delete" variant="quiet" onPress={() => remove(h)} />
          <Button label="Open" onPress={() => choose(h)} />
        </View>
      ))}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: space.xs, paddingVertical: space.xs,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.outlineVariant },
  grow: { flex: 1 },
});
