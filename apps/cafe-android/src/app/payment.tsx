import { useCallback, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { router, Stack } from "expo-router";
import { SvgXml } from "react-native-svg";
import { uuidv7 } from "@masalapos/domain/id";
import { getCafe, printerFor, type CafeBill, type PaymentInput } from "@masalapos/cafe-data";
import { upiPaymentUri, upiQrSvg } from "@masalapos/print";
import { TokenScreen } from "../bill/TokenScreen";
import { billErrorMessage, cart, cartTotals, useCart } from "../cart/cart";
import { linesForBill } from "../cart/cart-store";
import { deviceOffset } from "../dates";
import { completePayment } from "../payment/complete";
import { recordError } from "../errors/capture";
import { useDb, useData } from "../db/provider";
import { formatRupees } from "../money";
import { cashSuggestions, changeDue, parseAmountPaise, splitComplete } from "../payment/tender";
import { printQueue } from "../print/printer";
import { session } from "../staff/session";
import { color, radius, space, touch, type } from "../theme/tokens";
import { Banner, Button, Choice, Field, Icon, Money, Screen } from "../ui";

type Mode = PaymentInput["mode"] | "split";
const MODES = [{ value: "cash", label: "Cash" }, { value: "upi", label: "UPI" }, { value: "card", label: "Card" }, { value: "split", label: "Split" }] as const;
const SINGLE = [{ value: "cash", label: "Cash" }, { value: "upi", label: "UPI" }, { value: "card", label: "Card" }] as const;
const SPLIT_MODES = ["cash", "upi", "card"] as const;

/** Takes payment for the cart and saves the bill. The bill id is made once, so a second tap on Paid finds the same bill. */
export default function PaymentScreen() {
  const db = useDb();
  const snap = useCart();
  const cafe = useData(getCafe)!;
  const priced = useData((d) => cartTotals(d, snap));
  const [billId] = useState(uuidv7);
  const [mode, setMode] = useState<Mode>("cash");
  const [tendered, setTendered] = useState<number | null>(null);
  const [other, setOther] = useState("");
  const [split, setSplit] = useState<Record<PaymentInput["mode"], string>>({ cash: "", upi: "", card: "" });
  const [splitTendered, setSplitTendered] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<{ bill: CafeBill; change: number; jobId: string | null; hasPrinter: boolean; printError: string | null;
    kitchenJobId: string | null; kitchenProblem: string | null } | null>(null);
  const paying = useRef(false);
  const finish = useCallback(() => router.back(), []);

  if (done) return <><Stack.Screen options={{ presentation: "fullScreenModal", animation: "fade" }} />
    <TokenScreen bill={done.bill} changePaise={done.change} printJobId={done.jobId} hasPrinter={done.hasPrinter} printError={done.printError}
      kitchenJobId={done.kitchenJobId} kitchenProblem={done.kitchenProblem} onDone={finish} /></>;

  if (!priced || !priced.ok) {
    return (
      <Screen title="Payment" edges={["top", "bottom"]}>
        <Banner tone="error" text={priced ? billErrorMessage(priced.error) : "The cart is empty."} />
        <Button label="Back to the bill" onPress={() => router.back()} />
      </Screen>
    );
  }

  const total = priced.totals.totalPaise;
  const suggestions = cashSuggestions(total);
  // "Another amount" that cannot be read never counts as the exact total: Paid stays off and says why.
  const otherUnreadable = other.trim() !== "" && parseAmountPaise(other) === null;
  const cashGiven = other.trim() ? parseAmountPaise(other) : tendered ?? total;
  const change = mode === "cash" && cashGiven !== null ? changeDue(total, cashGiven) : 0;
  // A split is up to three parts, one per way to pay; only the cash part can be tendered with change.
  const splitParts = SPLIT_MODES.filter((m) => split[m].trim() !== "").map((m) => ({ mode: m, amountPaise: parseAmountPaise(split[m]) ?? -1 }));
  const splitUnreadable = SPLIT_MODES.some((m) => split[m].trim() !== "" && parseAmountPaise(split[m]) === null);
  const splitOk = !splitUnreadable && splitComplete(total, splitParts);
  const splitLeft = total - splitParts.reduce((n, p) => n + Math.max(0, p.amountPaise), 0);
  const cashPart = splitParts.find((p) => p.mode === "cash")?.amountPaise ?? 0;
  const splitCashGiven = splitTendered.trim() ? parseAmountPaise(splitTendered) : null;
  const splitChange = splitCashGiven !== null && cashPart > 0 ? changeDue(cashPart, splitCashGiven) : 0;
  const payments: PaymentInput[] = total === 0 ? []
    : mode === "split" ? (splitOk ? splitParts.map((p) => ({ mode: p.mode, amountPaise: p.amountPaise, refNote: null })) : [])
    : [{ mode, amountPaise: total, refNote: null }];
  const coversTotal = payments.reduce((n, p) => n + p.amountPaise, 0) === total
    && (mode !== "cash" || (change !== null && !otherUnreadable))
    && (mode !== "split" || (splitChange !== null && !(splitTendered.trim() && splitCashGiven === null)));
  const upiPart = splitParts.find((p) => p.mode === "upi")?.amountPaise ?? 0;
  const upiUri = cafe.upiId ? upiPaymentUri({ upiId: cafe.upiId, payeeName: cafe.name, amountPaise: mode === "split" ? Math.max(0, upiPart) : total,
    ref: billId.replace(/-/g, ""), note: "MasalaPOS Cafe" }) : null;
  const showsUpi = mode === "upi" || (mode === "split" && upiPart > 0);

  function paid() {
    // A ref, not state: two taps in the same frame both see the state before React re-renders.
    if (paying.current || !coversTotal || !priced?.ok) return;
    paying.current = true;
    setSaving(true);
    setProblem(null);
    const now = Date.now();
    try {
      const result = completePayment(db, {
        id: billId, lines: linesForBill(snap.lines), discountPaise: priced.discountPaise, discountNote: snap.discount ? snap.note || null : null,
        payments, now, tzOffsetMinutes: deviceOffset(now), staffId: session.get().staff?.id ?? "", approvedBy: snap.approvedBy,
        customerId: snap.customer?.id ?? null, orderKind: snap.orderKind, deliveryNote: snap.orderKind === "delivery" ? snap.deliveryNote : null,
      }, { printer: printerFor(db, "receipt"), enqueue: printQueue.enqueue, newId: uuidv7 });
      cart.clear();
      setDone({ bill: result.bill, change: mode === "cash" ? change ?? 0 : mode === "split" ? splitChange ?? 0 : 0, jobId: result.jobId, hasPrinter: printerFor(db, "receipt") !== null,
        printError: result.printError, kitchenJobId: result.kitchenJobId, kitchenProblem: result.kitchenProblem });
    } catch (e) {
      recordError(e, `payment ${mode}: ${snap.lines.map((l) => `${l.name} x${l.qty}${l.variantId ? " [variant]" : ""}`).join(", ")}`);
      const index = typeof e === "object" && e && "lineIndex" in e && typeof e.lineIndex === "number" ? e.lineIndex : undefined;
      setProblem(billErrorMessage(e, index !== undefined ? snap.lines[index]?.name : undefined));
      setSaving(false);
      paying.current = false;
    }
  }

  return (
    <Screen title="Payment" edges={["top", "bottom"]}
      actions={<Pressable accessibilityRole="button" accessibilityLabel="Back to the bill" onPress={() => router.back()} style={styles.iconKey}><Icon name="close" /></Pressable>}>
      <View style={styles.total}>
        <Text style={[type.label, { color: color.onSurfaceMuted }]}>To pay</Text>
        <Money paise={total} size="display" />
      </View>
      {total > 0 ? <Choice options={MODES} value={mode} onChange={(m) => { setMode(m); setProblem(null); }} /> : <Banner text="Nothing to pay: the discount covers the bill." />}

      {total > 0 && mode === "cash" && (
        <View style={styles.block}>
          <Text style={[type.label, { color: color.onSurface }]}>Cash received</Text>
          <View style={styles.notes}>
            {suggestions.map((s) => {
              const on = !other && (tendered ?? total) === s;
              return (
                <Pressable key={s} accessibilityRole="radio" accessibilityState={{ checked: on }} onPress={() => { setTendered(s); setOther(""); }}
                  style={[styles.note, on && styles.noteOn]}>
                  <Money paise={s} size="title" tone={on ? color.onPrimaryContainer : color.onSurface} />
                </Pressable>
              );
            })}
          </View>
          <Field label="Another amount (₹)" value={other} onChangeText={setOther} keyboardType="decimal-pad" placeholder="500"
            error={otherUnreadable ? "Enter an amount like 120 or 120.50" : other && change === null ? "That is less than the total." : null} />
          {change !== null && change > 0 ? (
            <View style={styles.change}><Text style={[type.title, { color: color.onSuccessContainer }]}>Change to give</Text><Money paise={change} size="headline" tone={color.onSuccessContainer} /></View>
          ) : null}
        </View>
      )}

      {total > 0 && mode === "split" && (
        <View style={styles.block}>
          <Text style={[type.body, { color: color.onSurfaceMuted }]}>Fill two or three ways to pay. Leave the others empty.</Text>
          {SINGLE.map((m) => {
            const text = split[m.value];
            const bad = text.trim() !== "" && parseAmountPaise(text) === null;
            return (
              <View key={m.value} style={styles.splitRow}>
                <View style={styles.grow}>
                  <Field label={`${m.label} (₹)`} value={text} onChangeText={(t) => setSplit({ ...split, [m.value]: t })} keyboardType="decimal-pad"
                    placeholder={splitLeft > 0 ? (splitLeft / 100).toFixed(2) : "0"} error={bad ? "Enter an amount like 120 or 120.50" : null} />
                </View>
                {!text.trim() && splitLeft > 0 ? (
                  <Button label="Rest" variant="quiet" onPress={() => setSplit({ ...split, [m.value]: (splitLeft / 100).toFixed(2) })} />
                ) : null}
              </View>
            );
          })}
          {cashPart > 0 ? (
            <Field label="Cash received (optional, ₹)" value={splitTendered} onChangeText={setSplitTendered} keyboardType="decimal-pad"
              error={splitTendered.trim() && splitCashGiven === null ? "Enter an amount like 120 or 120.50"
                : splitChange === null ? "That is less than the cash part." : null} />
          ) : null}
          {splitChange !== null && splitChange > 0 ? (
            <View style={styles.change}><Text style={[type.title, { color: color.onSuccessContainer }]}>Change to give</Text><Money paise={splitChange} size="headline" tone={color.onSuccessContainer} /></View>
          ) : null}
          {!splitUnreadable && splitParts.length > 0 && splitLeft !== 0 ? (
            <Text style={[type.body, { color: color.onSurface }]}>
              {splitLeft > 0 ? `${formatRupees(splitLeft)} still to cover` : `${formatRupees(-splitLeft)} more than the total`}
            </Text>
          ) : null}
          {new Set(splitParts.map((p) => p.mode)).size === 1 && splitParts.length > 0 && splitLeft === 0 ? (
            <Banner text="One way pays it all: choose that instead of Split." />
          ) : null}
        </View>
      )}

      {total > 0 && showsUpi && (
        upiUri ? (
          <View style={styles.qr}>
            <SvgXml xml={upiQrSvg(upiUri)} width={240} height={240} />
            <Text style={[type.small, { color: color.onSurfaceMuted }]}>Scan with any UPI app · {cafe.upiId}</Text>
          </View>
        ) : <Banner text="Add your UPI ID in More, Cafe details, to show a QR code here." />
      )}

      {problem ? <Banner tone="error" text={problem} /> : null}
      <Button label={saving ? "Saving…" : "Paid"} size="lg" busy={saving} disabled={!coversTotal} onPress={paid} style={styles.paid} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  total: { alignItems: "center", gap: space.xxs, paddingVertical: space.sm },
  block: { gap: space.sm },
  notes: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  note: { minHeight: touch.large, minWidth: 96, paddingHorizontal: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: color.outline,
    alignItems: "center", justifyContent: "center", backgroundColor: color.surface },
  noteOn: { backgroundColor: color.primaryContainer, borderColor: color.primary, borderWidth: 2 },
  change: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: space.md, borderRadius: radius.md, backgroundColor: color.successContainer },
  qr: { alignItems: "center", gap: space.xs, padding: space.md, backgroundColor: color.surface, borderRadius: radius.md },
  paid: { minHeight: 64 },
  splitRow: { flexDirection: "row", alignItems: "flex-end", gap: space.xs },
  grow: { flex: 1 },
  iconKey: { width: touch.min, height: touch.min, alignItems: "center", justifyContent: "center" },
});
