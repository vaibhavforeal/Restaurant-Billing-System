import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Redirect } from "expo-router";
import { SvgXml } from "react-native-svg";
import { uuidv7 } from "@masalapos/domain/id";
import { calculateBill, type Bill } from "@masalapos/domain/billing";
import { dateTime, receiptSlip, upiQrSvg } from "@masalapos/print";
import { hashPin, PIN_HASH_ITERATIONS } from "@masalapos/cafe-data";
import { color, space, type } from "../theme/tokens";
import { Screen } from "../ui";

const sampleBill: Bill = {
  ...calculateBill([{ pricePaise: 1800, qty: 2, gstRate: 5 }]),
  id: "self-check", billNo: 1, invoiceNo: "A/26-27/0001", orderId: "self-check", status: "paid", discountNote: null, createdAt: Date.now(),
  receipt: { restaurantName: "Self check", address: "", gstin: "", fssai: "", receiptFooter: "", gstMode: "included", orderType: "parcel",
    tableName: null, splitLabel: null, token: 1, items: [{ name: "Samosa", pricePaise: 1800, qty: 2, gstRate: 5 }] },
  payments: [{ mode: "cash", amountPaise: 3600, refNote: null, createdAt: Date.now() }], refundState: "none", creditNotes: [], refundedQty: {},
};

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ gap: 2 }}>
      <Text style={[type.label, { color: color.onSurfaceMuted }]}>{label}</Text>
      <Text style={[type.body, { color: color.onSurface }]} selectable>{value}</Text>
    </View>
  );
}

/** Development builds only: proves the shared TypeScript runs under Hermes. */
export default function SelfCheck() {
  const [checks] = useState(() => {
    const run = (fn: () => string) => { try { return fn(); } catch (e) { return `FAILED: ${e instanceof Error ? e.message : String(e)}`; } };
    return {
      id: run(() => uuidv7()),
      total: run(() => String(calculateBill([{ pricePaise: 1800, qty: 2, gstRate: 5 }]).totalPaise)),
      bytes: run(() => String(receiptSlip(sampleBill, 58).length)),
      qr: run(() => upiQrSvg("upi://pay?pa=test@upi&am=1.00")),
      date: run(() => dateTime(Date.now())),
    };
  });
  const [pinMs, setPinMs] = useState("measuring…");
  useEffect(() => {
    const start = Date.now();
    hashPin("1234").then(() => setPinMs(`${Date.now() - start} ms at ${PIN_HASH_ITERATIONS} rounds`), (e: unknown) => setPinMs(`FAILED: ${String(e)}`));
  }, []);
  if (!__DEV__) return <Redirect href="/more" />;
  return (
    <Screen title="Self-check" edges={["top", "bottom"]}>
      <Row label="uuidv7()" value={checks.id} />
      <Row label="calculateBill total (expect 3600)" value={checks.total} />
      <Row label="receiptSlip bytes (expect above 0)" value={checks.bytes} />
      <Row label="dateTime(now)" value={checks.date} />
      <Row label="PIN check (aim for 300 ms or less)" value={pinMs} />
      <Text style={[type.label, { color: color.onSurfaceMuted }]}>UPI QR (scan it; do not pay)</Text>
      {checks.qr.startsWith("<svg") ? <View style={{ padding: space.md, backgroundColor: color.surface, alignSelf: "flex-start" }}><SvgXml xml={checks.qr} width={220} height={220} /></View>
        : <Text style={[type.body, { color: color.error }]}>{checks.qr}</Text>}
    </Screen>
  );
}
