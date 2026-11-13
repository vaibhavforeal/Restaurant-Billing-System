import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { listBills } from "@masalapos/cafe-data";
import { useData } from "../../db/provider";
import { clockTime, deviceOffset, today } from "../../dates";
import { color, radius, space, touch, type } from "../../theme/tokens";
import { DateControl, Icon, Money, Screen } from "../../ui";

/** A day's bills, newest first, found by token or invoice number. */
export default function BillsScreen() {
  const [date, setDate] = useState(today);
  const [search, setSearch] = useState("");
  const bills = useData((db) => listBills(db, date, search));

  return (
    <Screen title="Bills">
      <DateControl value={date} onChange={setDate} />
      <View style={styles.search}>
        <Icon name="search" size={20} tint={color.onSurfaceMuted} />
        <TextInput value={search} onChangeText={setSearch} placeholder="Token or bill number" placeholderTextColor={color.onSurfaceMuted}
          style={[type.body, styles.searchInput]} accessibilityLabel="Search by token or bill number" autoCapitalize="characters" />
      </View>
      {bills.length === 0 ? <Text style={[type.body, { color: color.onSurfaceMuted }]}>{search ? "No bill matches." : "No bills on this day."}</Text> : null}
      <View style={styles.list}>
        {bills.map((b) => (
          <Pressable key={b.id} accessibilityRole="button" accessibilityLabel={`Token ${b.token}, ${b.invoiceNo}${b.voided ? ", void" : ""}`}
            onPress={() => router.push({ pathname: "/bill/[id]", params: { id: b.id } })}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: color.surfaceVariant }]}>
            <View style={styles.token}><Text style={[type.title, { color: color.onPrimaryContainer }]}>{b.token}</Text></View>
            <View style={styles.grow}>
              <Text style={[type.bodyStrong, { color: color.onSurface }]}>{b.invoiceNo}</Text>
              <Text style={[type.small, { color: color.onSurfaceMuted }]}>
                {clockTime(b.createdAt, deviceOffset(b.createdAt))} · {b.payments.length ? [...new Set(b.payments.map((p) => p.mode.toUpperCase()))].join(" + ") : "No payment"}
              </Text>
            </View>
            <View style={styles.end}>
              <Money paise={b.totalPaise} size="bodyStrong" tone={b.voided ? color.onSurfaceMuted : color.onSurface} style={b.voided ? styles.struck : null} />
              {b.voided ? <Text style={[type.caption, styles.void]}>VOID</Text> : null}
            </View>
          </Pressable>
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  search: { flexDirection: "row", alignItems: "center", gap: space.xs, minHeight: touch.min, paddingHorizontal: space.sm, borderRadius: radius.pill,
    backgroundColor: color.surface, borderWidth: 1, borderColor: color.outlineVariant },
  searchInput: { flex: 1, color: color.onSurface, paddingVertical: 0 },
  list: { backgroundColor: color.surface, borderRadius: radius.md, borderWidth: 1, borderColor: color.outlineVariant, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: touch.large + space.xs, paddingHorizontal: space.md, paddingVertical: space.xs,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.outlineVariant },
  token: { minWidth: 48, height: 48, borderRadius: radius.sm, backgroundColor: color.primaryContainer, alignItems: "center", justifyContent: "center", paddingHorizontal: space.xs },
  grow: { flex: 1 },
  end: { alignItems: "flex-end", gap: 2 },
  struck: { textDecorationLine: "line-through" },
  void: { color: color.onErrorContainer, backgroundColor: color.errorContainer, paddingHorizontal: space.xs, borderRadius: radius.sm, overflow: "hidden", fontWeight: "700" },
});
