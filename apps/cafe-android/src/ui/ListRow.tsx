import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { color, space, touch, type } from "../theme/tokens";
import { Icon } from "./Icon";

/** A row in a list: a title, an optional second line and something on the right. With onPress it shows a chevron. */
export function ListRow({ title, subtitle, trailing, onPress, accessibilityLabel }: {
  title: string; subtitle?: string; trailing?: ReactNode; onPress?: () => void; accessibilityLabel?: string;
}) {
  const body = (
    <>
      <View style={styles.text}>
        <Text style={[type.bodyStrong, { color: color.onSurface }]} numberOfLines={1}>{title}</Text>
        {subtitle ? <Text style={[type.small, { color: color.onSurfaceMuted }]} numberOfLines={2}>{subtitle}</Text> : null}
      </View>
      {trailing}
      {onPress ? <Icon name="chevron" size={20} tint={color.onSurfaceMuted} /> : null}
    </>
  );
  if (!onPress) return <View style={styles.row}>{body}</View>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? title} onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: color.surfaceVariant }]}>
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { minHeight: touch.large, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.md, paddingVertical: space.xs,
    backgroundColor: color.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.outlineVariant },
  text: { flex: 1, gap: 2 },
});
