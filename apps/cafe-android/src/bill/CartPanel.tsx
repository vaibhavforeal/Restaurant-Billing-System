import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { discountAllowed, getCounterSettings, maskPhone, type CafeSettings } from "@masalapos/cafe-data";
import { billErrorMessage, cart, type CartTotals, useCart } from "../cart/cart";
import { discountPaiseFor, type CartEntry, type Discount } from "../cart/cart-store";
import { useDb } from "../db/provider";
import { session } from "../staff/session";
import { useApproval } from "../staff/useApproval";
import { CustomerSheet } from "./CustomerSheet";
import { LineNoteSheet } from "./LineNoteSheet";
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

/** Discount as an amount in rupees or a percent, with an optional note. `onApply` decides whether it needs approval. */
function DiscountSheet({ visible, onClose, onApply }: { visible: boolean; onClose: () => void; onApply: (d: Discount, note: string) => void }) {
  const snap = useCart();
  const current = { value: snap.discount, note: snap.note };
  const [kind, setKind] = useState<Discount["kind"]>(current.value?.kind ?? "amount");
  const [text, setText] = useState("");
  const [note, setNote] = useState(current.note);
  const value = parseRupees(text);
  const valid = value !== null && value > 0 && (kind === "amount" || value <= 10000);
  function apply() {
    if (!valid) return;
    onClose();
    onApply(kind === "amount" ? { kind, paise: value } : { kind, bp: value }, note.trim());
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

const KINDS = [{ value: "takeaway", label: "Takeaway" }, { value: "delivery", label: "Delivery" }] as const;

/**
 * The cart: Takeaway or Delivery, the customer, lines with quantity steppers (long press for a kitchen note), a discount
 * (above the cashier's limit it needs a manager's or the owner's PIN), totals from the menu, Hold and Charge.
 */
export function CartPanel({ cafe, priced, onCharge, onHold, compact = false }: {
  cafe: CafeSettings; priced: CartTotals | null; onCharge: () => void; onHold: () => void; compact?: boolean;
}) {
  const db = useDb();
  const snap = useCart();
  const { approve, sheet } = useApproval();
  const [discountOpen, setDiscountOpen] = useState(false);
  const [customerOpen, setCustomerOpen] = useState(false);
  const [noteLine, setNoteLine] = useState<CartEntry | null>(null);
  const [discountProblem, setDiscountProblem] = useState<string | null>(null);
  const lines = snap.lines;
  const badLine = priced && !priced.ok ? priced.lineIndex : null;
  const t = priced?.ok ? priced.totals : null;
  const { discount, note } = snap;

  const staffNow = session.get().staff;
  const subtotalNow = priced?.ok ? priced.totals.subtotalPaise : 0;
  const needsApproval = discount !== null && snap.approvedBy === null && staffNow !== null && priced?.ok === true
    && !discountAllowed(staffNow.role, priced.discountPaise, subtotalNow, getCounterSettings(db).cashierDiscountBp);

  async function askAgain() {
    if (!discount) return;
    const by = await approve("bills.discount", { title: "Approve discount" });
    if (by) cart.setApproval(by);
  }

  async function applyDiscount(d: Discount, discountNote: string) {
    setDiscountProblem(null);
    const subtotal = priced?.ok ? priced.totals.subtotalPaise : lines.reduce((n, l) => n + l.pricePaise * l.qty, 0);
    const staff = session.get().staff;
    if (staff && discountAllowed(staff.role, discountPaiseFor(d, subtotal), subtotal, getCounterSettings(db).cashierDiscountBp)) {
      cart.setDiscount(d, discountNote);
      return;
    }
    const by = await approve("bills.discount", { title: "Approve discount" });
    if (!by) { setDiscountProblem("A manager or the owner must approve this discount."); return; }
    cart.setDiscount(d, discountNote);
    cart.setApproval(by);
  }

  const orderArea = (
    <View style={styles.order}>
      <Choice options={KINDS} value={snap.orderKind} onChange={(k) => cart.setOrderKind(k)} />
      {snap.orderKind === "delivery" ? (
        <Field label="Deliver to" value={snap.deliveryNote} onChangeText={(t) => cart.setDeliveryNote(t)} maxLength={200} placeholder="Flat 4, ring twice" />
      ) : null}
      {snap.customer ? (
        <View style={styles.chip}>
          <Text style={[type.label, styles.grow, { color: color.onSurface }]} numberOfLines={1}>
            {snap.customer.name} · {maskPhone(snap.customer.phone)}
          </Text>
          <Pressable accessibilityRole="button" accessibilityLabel={`Remove customer ${snap.customer.name}`} onPress={() => cart.setCustomer(null)} style={styles.step}>
            <Icon name="close" size={20} />
          </Pressable>
        </View>
      ) : (
        <Button label="Customer" icon="plus" variant="quiet" onPress={() => setCustomerOpen(true)} />
      )}
    </View>
  );

  return (
    <View style={styles.panel}>
      <ScrollView style={styles.lines} contentContainerStyle={{ paddingBottom: space.sm }}>
        {orderArea}
        {lines.length === 0 ? <Text style={[type.body, styles.empty]}>Tap an item to start a bill.</Text> : null}
        {lines.map((l, i) => (
          <View key={l.key} style={[styles.line, badLine === i && styles.badLine]}>
            <Pressable style={styles.grow} onLongPress={() => setNoteLine(l)} accessibilityRole="button"
              accessibilityLabel={`${l.name}${l.note ? `, note ${l.note}` : ""}`} accessibilityHint="Long press to add a note for the kitchen">
              <Text style={[type.bodyStrong, { color: color.onSurface }]} numberOfLines={2}>{l.name}</Text>
              {l.note ? <Text style={[type.caption, styles.note]} numberOfLines={1}>{l.note}</Text> : null}
              <Money paise={l.pricePaise * l.qty} size="small" tone={color.onSurfaceMuted} />
            </Pressable>
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
        {discountProblem ? <Banner tone="warning" text={discountProblem} /> : null}
        {needsApproval ? (
          <Banner tone="warning" text="The items changed, so this discount needs approval again."
            action={{ label: "Approve", onPress: () => void askAgain() }} />
        ) : null}
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
          {lines.length ? <Button label="Hold" variant="secondary" onPress={onHold} /> : null}
          <Button label={t ? `Charge ₹${(t.totalPaise / 100).toFixed(2)}` : "Charge"} size="lg" disabled={!t || needsApproval} onPress={onCharge} style={styles.grow} />
        </View>
      </View>
      <DiscountSheet key={discountOpen ? "open" : "closed"} visible={discountOpen} onClose={() => setDiscountOpen(false)}
        onApply={(d, n) => void applyDiscount(d, n)} />
      <CustomerSheet visible={customerOpen} onClose={() => setCustomerOpen(false)} onPick={(c) => { cart.setCustomer(c); setCustomerOpen(false); }} />
      <LineNoteSheet key={noteLine?.key ?? "none"} line={noteLine} onClose={() => setNoteLine(null)} />
      {sheet}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { flex: 1, backgroundColor: color.surface },
  lines: { flex: 1 },
  empty: { color: color.onSurfaceMuted, padding: space.md },
  order: { padding: space.md, gap: space.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.outlineVariant },
  chip: { flexDirection: "row", alignItems: "center", paddingLeft: space.md, borderRadius: radius.pill, backgroundColor: color.primaryContainer },
  note: { color: color.onSurfaceMuted, fontStyle: "italic" },
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
