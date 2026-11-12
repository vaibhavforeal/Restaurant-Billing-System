import { StyleSheet, Text, View } from "react-native";
import type { CafeBill } from "@masalapos/cafe-data";
import { billTextLines } from "@masalapos/domain/bill-print";
import { clockTime, deviceOffset, longDate } from "../dates";
import { color, radius, space, type } from "../theme/tokens";
import { Money } from "../ui";

function Pair({ label, paise, strong = false }: { label: string; paise: number; strong?: boolean }) {
  return (
    <View style={styles.pair}>
      <Text style={[strong ? type.title : type.small, styles.grow, { color: strong ? color.onSurface : color.onSurfaceMuted }]}>{label}</Text>
      <Money paise={paise} size={strong ? "title" : "small"} tone={strong ? color.onSurface : color.onSurfaceMuted} />
    </View>
  );
}

/** A saved bill drawn with native text from its frozen receipt: what was printed on the day. */
export function ReceiptView({ bill }: { bill: CafeBill }) {
  const r = bill.receipt;
  const gst = bill.cgstPaise + bill.sgstPaise;
  return (
    <View style={[styles.paper, bill.voided && styles.voidPaper]}>
      <Text style={[type.title, styles.center]}>{r.restaurantName}</Text>
      {billTextLines(r.receiptHeader ?? "").map((t, i) => <Text key={`h${i}`} style={[type.small, styles.center, styles.muted]}>{t}</Text>)}
      {r.address ? <Text style={[type.small, styles.center, styles.muted]}>{r.address}</Text> : null}
      {r.gstin ? <Text style={[type.small, styles.center, styles.muted]}>GSTIN: {r.gstin}</Text> : null}
      {bill.voided ? (
        <View style={styles.voidBox}>
          <Text style={[type.title, { color: color.onErrorContainer }]}>VOID</Text>
          <Text style={[type.small, { color: color.onErrorContainer }]}>{bill.voided.creditNoteNo} · {bill.voided.reason}</Text>
        </View>
      ) : null}
      <View style={styles.tokenRow}>
        <Text style={[type.headline, { color: color.onSurface }]}>Token {bill.token}</Text>
        <View style={{ alignItems: "flex-end" }}>
          <Text style={[type.label, { color: color.onSurface }]}>{bill.invoiceNo}</Text>
          <Text style={[type.small, styles.muted]}>{longDate(bill.businessDate)} · {clockTime(bill.createdAt, deviceOffset(bill.createdAt))}</Text>
        </View>
      </View>
      <View style={styles.rule} />
      {r.items.map((item, i) => (
        <View key={i} style={styles.item}>
          <View style={styles.grow}>
            <Text style={[type.body, { color: color.onSurface }]}>{item.name}</Text>
            <Text style={[type.caption, styles.muted]}>{item.qty} × ₹{(item.pricePaise / 100).toFixed(2)}{r.gstMode !== "none" ? ` · GST ${item.gstRate}%` : ""}</Text>
          </View>
          <Money paise={item.pricePaise * item.qty} />
        </View>
      ))}
      <View style={styles.rule} />
      <Pair label="Subtotal" paise={bill.subtotalPaise} />
      {bill.discountPaise > 0 ? <Pair label={bill.discountNote ? `Discount (${bill.discountNote})` : "Discount"} paise={-bill.discountPaise} /> : null}
      {r.gstMode === "exclusive" ? bill.taxes.map((t) => <Pair key={t.gstRate} label={`CGST + SGST ${t.gstRate}%`} paise={t.cgstPaise + t.sgstPaise} />) : null}
      {bill.roundingPaise ? <Pair label="Round off" paise={bill.roundingPaise} /> : null}
      <Pair label="Total" paise={bill.totalPaise} strong />
      {r.gstMode === "included" && gst > 0 ? <Text style={[type.caption, styles.muted]}>Includes GST of ₹{(gst / 100).toFixed(2)}</Text> : null}
      <View style={styles.rule} />
      {bill.payments.length ? bill.payments.map((p, i) => <Pair key={i} label={p.mode.toUpperCase()} paise={p.amountPaise} />)
        : <Text style={[type.small, styles.muted]}>No payment taken (fully discounted).</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  paper: { backgroundColor: color.surface, borderRadius: radius.md, borderWidth: 1, borderColor: color.outlineVariant, padding: space.md, gap: space.xxs },
  voidPaper: { borderColor: color.error },
  center: { textAlign: "center", color: color.onSurface },
  muted: { color: color.onSurfaceMuted },
  voidBox: { alignItems: "center", backgroundColor: color.errorContainer, borderRadius: radius.sm, padding: space.xs, marginTop: space.xs },
  tokenRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: space.sm },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: color.outlineVariant, marginVertical: space.xs },
  item: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 2 },
  pair: { flexDirection: "row", alignItems: "baseline" },
  grow: { flex: 1 },
});
