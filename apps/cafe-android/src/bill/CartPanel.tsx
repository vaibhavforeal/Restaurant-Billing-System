import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { CafeSettings } from "@masalapos/cafe-data";
import { billErrorMessage, type CartTotals, useCart } from "../cart/cart";
import type { Discount } from "../cart/cart-store";
import { parseRupees } from "../money";
import { color, radius, space, touch, type } from "../theme/tokens";
import { Banner, Button, Choice, Field, Icon, Money, Sheet } from "../ui";

function Row({ label, paise, strong = false }: { label: string; paise: number; strong?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={[strong ? type.title : type.small, styles.grow, { color: strong ? color.onSurface : color.onSurfaceMuted }]}>{label}</Text>
      <Money paise={paise} size={strong ? "title" : "small"} tone={strong ? color.onSurface : color.onSurfaceMuted} />
    </View>
  );
}

/** Discount as an amount in rupees or a percent, with an optional note. */
function DiscountSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const cart = useCart();
  const current = cart.discount();
  const [kind, setKind] = useState<Discount["kind"]>(current.value?.kind ?? "amount");
  const [text, setText] = useState("");
  const [note, setNote] = useState(current.note);
  const value = parseRupees(text);
  const valid = value !== null && value > 0 && (kind === "amount" || value <= 10000);
  function apply() {
    if (!valid) return;
    cart.setDiscount(kind === "amount" ? { kind, paise: value } : { kind, bp: value }, note.trim());
    onClose();
  }
  return (
    <Sheet visible={visible} title="Discount" onClose={onClose}
      footer={<>
        <Button label="Apply discount" size="lg" disabled={!valid} onPress={apply} />
        {current.value ? <Button label="Remove discount" variant="danger" onPress={() => { cart.setDiscount(null); setText(""); onClose(); }} /> : null}
      </>}>
      <Choice options={[{ value: "amount", label: "Amount (₹)" }, { value: "percent", label: "Percent (%)" }]} value={kind} onChange={setKind} />
      <Field label={kind === "amount" ? "Discount in rupees" : "Discount percent"} value={text} onChangeText={setText} keyboardType="decimal-pad"
        placeholder={kind === "amount" ? "20" : "10"} error={text && !valid ? (kind === "percent" ? "Use a percent from 0.01 to 100" : "Enter an amount in rupees") : null} />
      <Field label="Note (optional)" value={note} onChangeText={setNote} placeholder="Regular customer" maxLength={80} />
    </Sheet>
  );
}

/** The cart: lines with quantity steppers, a discount, totals from the menu, and Charge. */
export function CartPanel({ cafe, priced, onCharge, compact = false }: { cafe: CafeSettings; priced: CartTotals | null; onCharge: () => void; compact?: boolean }) {
  const cart = useCart();
  const [discountOpen, setDiscountOpen] = useState(false);
  const lines = cart.entries();
  const badLine = priced && !priced.ok ? priced.lineIndex : null;
  const t = priced?.ok ? priced.totals : null;
  const { value: discount, note } = cart.discount();

  return (
    <View style={styles.panel}>
      <ScrollView style={styles.lines} contentContainerStyle={{ paddingBottom: space.sm }}>
        {lines.length === 0 ? <Text style={[type.body, styles.empty]}>Tap an item to start a bill.</Text> : null}
        {lines.map((l, i) => (
          <View key={l.key} style={[styles.line, badLine === i && styles.badLine]}>
            <View style={styles.grow}>
              <Text style={[type.bodyStrong, { color: color.onSurface }]} numberOfLines={2}>{l.name}</Text>
              <Money paise={l.pricePaise * l.qty} size="small" tone={color.onSurfaceMuted} />
            </View>
            <View style={styles.stepper}>
              <Pressable accessibilityRole="button" accessibilityLabel={`One less ${l.name}`} style={styles.step} onPress={() => cart.setQty(l.key, l.qty - 1)}>
                <Icon name="minus" />
              </Pressable>
              <Text style={[type.title, styles.qty]} accessibilityLabel={`Quantity ${l.qty}`}>{l.qty}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel={`One more ${l.name}`} style={styles.step} onPress={() => cart.setQty(l.key, l.qty + 1)}>
                <Icon name="plus" />
              </Pressable>
            </View>
          </View>
        ))}
      </ScrollView>
      <View style={styles.footer}>
        {priced && !priced.ok ? (
          <Banner tone="error" text={billErrorMessage(priced.error, badLine !== null ? lines[badLine]?.name : undefined)} />
        ) : null}
        {lines.length && !compact ? (
          <Button label={discount ? `Discount${note ? `: ${note}` : ""}` : "Add discount"} variant="quiet" onPress={() => setDiscountOpen(true)} />
        ) : null}
        {t ? (
          <View style={styles.totals}>
            {t.discountPaise > 0 || t.roundingPaise !== 0 || cafe.gstMode === "exclusive" ? <Row label="Subtotal" paise={t.subtotalPaise} /> : null}
            {t.discountPaise > 0 ? <Row label="Discount" paise={-t.discountPaise} /> : null}
            {cafe.gstMode === "exclusive" ? <Row label="GST" paise={t.cgstPaise + t.sgstPaise} /> : null}
            {t.roundingPaise !== 0 ? <Row label="Round off" paise={t.roundingPaise} /> : null}
            <Row label="Total" paise={t.totalPaise} strong />
            {cafe.gstMode === "included" && t.cgstPaise + t.sgstPaise > 0 ? (
              <Text style={[type.caption, { color: color.onSurfaceMuted }]}>Includes GST of ₹{((t.cgstPaise + t.sgstPaise) / 100).toFixed(2)}</Text>
            ) : null}
          </View>
        ) : null}
        <View style={styles.actions}>
          {compact && lines.length ? <Button label="Discount" variant="secondary" onPress={() => setDiscountOpen(true)} /> : null}
          <Button label={t ? `Charge ₹${(t.totalPaise / 100).toFixed(2)}` : "Charge"} size="lg" disabled={!t} onPress={onCharge} style={styles.grow} />
        </View>
      </View>
      <DiscountSheet key={discountOpen ? "open" : "closed"} visible={discountOpen} onClose={() => setDiscountOpen(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { flex: 1, backgroundColor: color.surface },
  lines: { flex: 1 },
  empty: { color: color.onSurfaceMuted, padding: space.md },
  line: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingLeft: space.md, paddingRight: space.xs, paddingVertical: space.xs,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.outlineVariant },
  badLine: { backgroundColor: color.errorContainer },
  stepper: { flexDirection: "row", alignItems: "center", backgroundColor: color.surfaceVariant, borderRadius: radius.pill },
  step: { width: touch.min, height: touch.min, alignItems: "center", justifyContent: "center" },
  qty: { minWidth: 32, textAlign: "center", color: color.onSurface },
  footer: { padding: space.md, gap: space.xs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.outlineVariant },
  totals: { gap: 2 },
  row: { flexDirection: "row", alignItems: "baseline" },
  actions: { flexDirection: "row", gap: space.sm, marginTop: space.xs },
  grow: { flex: 1 },
});
