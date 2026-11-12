import { useCallback, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { router, Stack } from "expo-router";
import { SvgXml } from "react-native-svg";
import { uuidv7 } from "@masalapos/domain/id";
import { createBill, getCafe, printerFor, printTarget, type CafeBill, type PaymentInput } from "@masalapos/cafe-data";
import { receiptSlip, upiPaymentUri, upiQrSvg } from "@masalapos/print";
import { TokenScreen } from "../bill/TokenScreen";
import { billErrorMessage, cart, cartTotals, useCart } from "../cart/cart";
import { useDb, useData } from "../db/provider";
import { formatRupees, parseRupees } from "../money";
import { cashSuggestions, changeDue, remaining } from "../payment/tender";
import { printQueue } from "../print/printer";
import { color, radius, space, touch, type } from "../theme/tokens";
import { Banner, Button, Choice, Field, Icon, Money, Screen } from "../ui";

type Mode = PaymentInput["mode"] | "split";
const MODES = [{ value: "cash", label: "Cash" }, { value: "upi", label: "UPI" }, { value: "card", label: "Card" }, { value: "split", label: "Split" }] as const;
const SINGLE = [{ value: "cash", label: "Cash" }, { value: "upi", label: "UPI" }, { value: "card", label: "Card" }] as const;

/** Takes payment for the cart and saves the bill. The bill id is made once, so a second tap on Paid finds the same bill. */
export default function PaymentScreen() {
  const db = useDb();
  useCart();
  const cafe = useData(getCafe)!;
  const priced = useData((d) => cartTotals(d));
  const [billId] = useState(uuidv7);
  const [mode, setMode] = useState<Mode>("cash");
  const [tendered, setTendered] = useState<number | null>(null);
  const [other, setOther] = useState("");
  const [splitFirst, setSplitFirst] = useState<PaymentInput["mode"]>("cash");
  const [splitSecond, setSplitSecond] = useState<PaymentInput["mode"]>("upi");
  const [splitAmount, setSplitAmount] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<{ bill: CafeBill; change: number; jobId: string | null; hasPrinter: boolean } | null>(null);
  const finish = useCallback(() => router.back(), []);

  if (done) return <><Stack.Screen options={{ presentation: "fullScreenModal", animation: "fade" }} />
    <TokenScreen bill={done.bill} changePaise={done.change} printJobId={done.jobId} hasPrinter={done.hasPrinter} onDone={finish} /></>;

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
  const cashGiven = other ? parseRupees(other) : tendered ?? total;
  const change = mode === "cash" && cashGiven !== null ? changeDue(total, cashGiven) : 0;
  const firstPart = parseRupees(splitAmount);
  const splitOk = firstPart !== null && firstPart > 0 && firstPart < total && splitFirst !== splitSecond;
  const payments: PaymentInput[] = total === 0 ? []
    : mode === "split" ? (splitOk ? [{ mode: splitFirst, amountPaise: firstPart, refNote: null }, { mode: splitSecond, amountPaise: remaining(total, [firstPart]), refNote: null }] : [])
    : [{ mode, amountPaise: total, refNote: null }];
  const coversTotal = payments.reduce((n, p) => n + p.amountPaise, 0) === total && (mode !== "cash" || change !== null);
  const upiUri = cafe.upiId ? upiPaymentUri({ upiId: cafe.upiId, payeeName: cafe.name, amountPaise: mode === "split" && splitFirst === "upi" && firstPart ? firstPart
    : mode === "split" && splitSecond === "upi" && firstPart ? remaining(total, [firstPart]) : total, ref: billId.replace(/-/g, ""), note: "MasalaPOS Cafe" }) : null;
  const showsUpi = mode === "upi" || (mode === "split" && (splitFirst === "upi" || splitSecond === "upi"));

  function paid() {
    if (saving || !coversTotal) return;
    setSaving(true);
    setProblem(null);
    try {
      const now = Date.now();
      const { value, note } = cart.discount();
      const bill = createBill(db, { id: billId, lines: cart.toLines(), discountPaise: priced!.ok ? priced!.discountPaise : 0,
        discountNote: value ? note || null : null, payments, now, tzOffsetMinutes: -new Date(now).getTimezoneOffset() });
      const printer = printerFor(db, "receipt");
      let jobId: string | null = null;
      if (printer) {
        jobId = uuidv7();
        printQueue.enqueue({ id: jobId, label: `Bill ${bill.invoiceNo}`, target: printTarget(printer), bytes: receiptSlip(bill, printer.paperWidth, printer.profile), copies: printer.profile.copies });
      }
      cart.clear();
      setDone({ bill, change: mode === "cash" ? change ?? 0 : 0, jobId, hasPrinter: printer !== null });
    } catch (e) {
      const index = typeof e === "object" && e && "lineIndex" in e && typeof e.lineIndex === "number" ? e.lineIndex : undefined;
      setProblem(billErrorMessage(e, index !== undefined ? cart.entries()[index]?.name : undefined));
      setSaving(false);
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
            error={other && change === null ? "That is less than the total." : null} />
          {change !== null && change > 0 ? (
            <View style={styles.change}><Text style={[type.title, { color: color.onSuccessContainer }]}>Change to give</Text><Money paise={change} size="headline" tone={color.onSuccessContainer} /></View>
          ) : null}
        </View>
      )}

      {total > 0 && mode === "split" && (
        <View style={styles.block}>
          <Choice label="First part" options={SINGLE} value={splitFirst} onChange={setSplitFirst} />
          <Field label="First part amount (₹)" value={splitAmount} onChangeText={setSplitAmount} keyboardType="decimal-pad"
            error={splitAmount && !(firstPart !== null && firstPart > 0 && firstPart < total) ? `Enter less than ${formatRupees(total)}` : null} />
          <Choice label="Rest by" options={SINGLE} value={splitSecond} onChange={setSplitSecond} />
          {splitFirst === splitSecond ? <Banner tone="warning" text="Choose two different ways to pay." /> : null}
          {firstPart !== null && firstPart > 0 && firstPart < total ? (
            <Text style={[type.body, { color: color.onSurface }]}>{SINGLE.find((s) => s.value === splitSecond)!.label} pays {formatRupees(remaining(total, [firstPart]))}</Text>
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
  iconKey: { width: touch.min, height: touch.min, alignItems: "center", justifyContent: "center" },
});
