import { Pressable, StyleSheet, Text, View } from "react-native";
import { color, radius, space, touch, type } from "../theme/tokens";
import { Money } from "./Money";

/** A menu item on the Bill screen. Unavailable items are dimmed and cannot be tapped. */
export function Tile({ name, pricePaise, fromPrice = false, disabled = false, onPress }: {
  name: string; pricePaise: number; fromPrice?: boolean; disabled?: boolean; onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name}${disabled ? ", not available" : ""}`}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.tile, disabled && styles.off, pressed && styles.pressed]}
    >
      <Text style={[type.bodyStrong, styles.name, disabled && { color: color.disabled }]} numberOfLines={2}>{name}</Text>
      <View style={styles.price}>
        {fromPrice && <Text style={[type.caption, { color: disabled ? color.disabled : color.onSurfaceMuted }]}>from </Text>}
        <Money paise={pricePaise} size="small" tone={disabled ? color.disabled : color.onSurfaceMuted} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: { minHeight: 88, minWidth: touch.min, padding: space.sm, borderRadius: radius.md, backgroundColor: color.surface,
    borderWidth: 1, borderColor: color.outlineVariant, justifyContent: "space-between", gap: space.xs },
  name: { color: color.onSurface },
  price: { flexDirection: "row", alignItems: "baseline" },
  off: { backgroundColor: color.surfaceVariant },
  pressed: { backgroundColor: color.primaryContainer, borderColor: color.primary },
});
