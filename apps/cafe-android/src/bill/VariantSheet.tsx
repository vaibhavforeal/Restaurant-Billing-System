import { Pressable, StyleSheet, Text } from "react-native";
import type { Item } from "@masalapos/cafe-data";
import { color, radius, space, touch, type } from "../theme/tokens";
import { Money, Sheet } from "../ui";

/** Picks a size or variant for an item; one tap adds it to the cart. */
export function VariantSheet({ item, onPick, onClose }: { item: Item | null; onPick: (item: Item, variantId: string) => void; onClose: () => void }) {
  return (
    <Sheet visible={item !== null} title={item?.name ?? ""} onClose={onClose}>
      {item?.variants.map((v) => (
        <Pressable key={v.id} accessibilityRole="button" accessibilityLabel={`${v.name}, add to bill`} onPress={() => onPick(item, v.id)}
          style={({ pressed }) => [styles.option, pressed && styles.pressed]}>
          <Text style={[type.title, styles.name]}>{v.name}</Text>
          <Money paise={v.pricePaise} size="title" />
        </Pressable>
      ))}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  option: { minHeight: touch.large + space.sm, flexDirection: "row", alignItems: "center", paddingHorizontal: space.md, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.outlineVariant, backgroundColor: color.surface },
  pressed: { backgroundColor: color.primaryContainer, borderColor: color.primary },
  name: { flex: 1, color: color.onSurface },
});
