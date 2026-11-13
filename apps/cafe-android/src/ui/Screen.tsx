import type { ReactNode } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { color, space, type } from "../theme/tokens";

/** A screen: safe-area padding, an optional title and actions, and scrolling content unless `scroll` is false. */
export function Screen({ title, actions, scroll = true, children, edges = ["top"] }: {
  title?: string; actions?: ReactNode; scroll?: boolean; children: ReactNode; edges?: Array<"top" | "bottom" | "left" | "right">;
}) {
  const header = title ? (
    <View style={styles.header}>
      <Text style={[type.headline, styles.title]} accessibilityRole="header">{title}</Text>
      {actions}
    </View>
  ) : null;
  return (
    <SafeAreaView style={styles.fill} edges={edges}>
      {header}
      {scroll ? <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">{children}</ScrollView>
        : <View style={[styles.fill, styles.flat]}>{children}</View>}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: color.background },
  header: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.md, paddingTop: space.md, paddingBottom: space.xs },
  title: { flex: 1, color: color.onSurface },
  content: { padding: space.md, gap: space.md, paddingBottom: space.xxl },
  flat: { paddingHorizontal: 0 },
});
