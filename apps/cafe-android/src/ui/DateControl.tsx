import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { addDays, longDate, monthGrid, today } from "../dates";
import { color, radius, space, touch, type } from "../theme/tokens";
import { Icon } from "./Icon";
import { Sheet } from "./Sheet";

const WEEK = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** A business date with previous and next day, and a month calendar to jump further. Future days are not offered. */
export function DateControl({ value, onChange }: { value: string; onChange: (date: string) => void }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => value.slice(0, 7));
  const latest = today();
  const [y, m] = view.split("-").map(Number) as [number, number];
  const shiftMonth = (n: number) => { const d = new Date(Date.UTC(y, m - 1 + n, 1)); setView(d.toISOString().slice(0, 7)); };

  return (
    <View style={styles.row}>
      <Pressable accessibilityRole="button" accessibilityLabel="Previous day" onPress={() => onChange(addDays(value, -1))} style={styles.key}><Icon name="back" /></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={`Date ${longDate(value)}. Choose another date`} style={styles.date}
        onPress={() => { setView(value.slice(0, 7)); setOpen(true); }}>
        <Text style={[type.title, { color: color.onSurface }]}>{value === latest ? "Today" : longDate(value)}</Text>
        {value === latest ? <Text style={[type.caption, { color: color.onSurfaceMuted }]}>{longDate(value)}</Text> : null}
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Next day" accessibilityState={{ disabled: value >= latest }} disabled={value >= latest}
        onPress={() => onChange(addDays(value, 1))} style={styles.key}><Icon name="chevron" tint={value >= latest ? color.disabled : color.onSurface} /></Pressable>

      <Sheet visible={open} title="Choose a date" onClose={() => setOpen(false)}>
        <View style={styles.monthRow}>
          <Pressable accessibilityRole="button" accessibilityLabel="Previous month" onPress={() => shiftMonth(-1)} style={styles.key}><Icon name="back" /></Pressable>
          <Text style={[type.title, styles.month]}>{MONTH_NAMES[m - 1]} {y}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Next month" onPress={() => shiftMonth(1)} style={styles.key}><Icon name="chevron" /></Pressable>
        </View>
        <View style={styles.grid}>
          {WEEK.map((w) => <Text key={w} style={[type.caption, styles.cell, styles.weekday]}>{w}</Text>)}
          {monthGrid(y, m).map((d, i) => d === null ? <View key={`b${i}`} style={styles.cell} /> : (
            <Pressable key={d} accessibilityRole="button" accessibilityLabel={longDate(d)} disabled={d > latest}
              onPress={() => { onChange(d); setOpen(false); }}
              style={[styles.cell, styles.day, d === value && styles.dayOn]}>
              <Text style={[type.body, { color: d > latest ? color.disabled : d === value ? color.onPrimaryContainer : color.onSurface }]}>{Number(d.slice(8))}</Text>
            </Pressable>
          ))}
        </View>
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", backgroundColor: color.surface, borderRadius: radius.md, borderWidth: 1, borderColor: color.outlineVariant },
  key: { width: touch.min, height: touch.min, alignItems: "center", justifyContent: "center" },
  date: { flex: 1, minHeight: touch.min, alignItems: "center", justifyContent: "center" },
  monthRow: { flexDirection: "row", alignItems: "center" },
  month: { flex: 1, textAlign: "center", color: color.onSurface },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  cell: { width: `${100 / 7}%`, minHeight: touch.min, alignItems: "center", justifyContent: "center" },
  weekday: { color: color.onSurfaceMuted, textAlign: "center", textAlignVertical: "center" },
  day: { borderRadius: radius.pill },
  dayOn: { backgroundColor: color.primaryContainer },
});
