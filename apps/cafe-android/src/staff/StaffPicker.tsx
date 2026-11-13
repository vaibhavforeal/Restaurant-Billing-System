import { Pressable, StyleSheet, Text, View } from "react-native";
import type { CafeRole, Staff } from "@masalapos/cafe-data";
import { color, radius, space, touch, type } from "../theme/tokens";

export const ROLE_NAMES: Record<CafeRole, string> = { owner: "Owner", manager: "Manager", cashier: "Cashier" };

/** Name tiles for choosing who is entering a PIN. Works as a wrapping grid on a phone and a tablet. */
export function StaffPicker({ staff, onPick }: { staff: Staff[]; onPick: (staff: Staff) => void }) {
  if (!staff.length) return <Text style={[type.body, { color: color.onSurfaceMuted }]}>Nobody on the staff list can do this.</Text>;
  return (
    <View style={styles.grid}>
      {staff.map((s) => (
        <Pressable key={s.id} accessibilityRole="button" accessibilityLabel={`${s.name}, ${ROLE_NAMES[s.role]}`} onPress={() => onPick(s)}
          style={({ pressed }) => [styles.tile, pressed && styles.pressed]}>
          <Text style={[type.bodyStrong, { color: color.onSurface }]} numberOfLines={2}>{s.name}</Text>
          <Text style={[type.caption, { color: color.onSurfaceMuted }]}>{ROLE_NAMES[s.role]}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  tile: { minWidth: 140, flexGrow: 1, flexBasis: 140, minHeight: Math.max(touch.min, 72), padding: space.sm, borderRadius: radius.md,
    backgroundColor: color.surface, borderWidth: 1, borderColor: color.outlineVariant, justifyContent: "center", gap: space.xxs },
  pressed: { backgroundColor: color.primaryContainer, borderColor: color.primary },
});
