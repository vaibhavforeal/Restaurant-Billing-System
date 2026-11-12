import { Pressable, StyleSheet, Text, View } from "react-native";
import { color, radius, space, touch, type } from "../theme/tokens";

/** Pick one of a few options, shown as a row of chips. */
export function Choice<T extends string | number>({ label, options, value, onChange }: {
  label?: string; options: ReadonlyArray<{ value: T; label: string }>; value: T; onChange: (value: T) => void;
}) {
  return (
    <View style={styles.wrap} accessibilityRole="radiogroup" {...(label ? { accessibilityLabel: label } : {})}>
      {label ? <Text style={[type.label, { color: color.onSurface }]}>{label}</Text> : null}
      <View style={styles.row}>
        {options.map((o) => {
          const on = o.value === value;
          return (
            <Pressable key={String(o.value)} accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={o.label}
              onPress={() => onChange(o.value)} style={[styles.chip, on && styles.on]}>
              <Text style={[type.label, { color: on ? color.onPrimaryContainer : color.onSurface }]}>{o.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.xxs },
  row: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  chip: { minHeight: touch.min, minWidth: touch.min, paddingHorizontal: space.md, borderRadius: radius.pill, borderWidth: 1,
    borderColor: color.outline, alignItems: "center", justifyContent: "center", backgroundColor: color.surface },
  on: { backgroundColor: color.primaryContainer, borderColor: color.primary, borderWidth: 2 },
});
