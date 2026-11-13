import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { BillError, getBill, getCounterSettings, printerFor, printTarget, voidBill } from "@masalapos/cafe-data";
import { uuidv7 } from "@masalapos/domain/id";
import { receiptSlip } from "@masalapos/print";
import { ReceiptView } from "../../bill/ReceiptView";
import { useDb, useData } from "../../db/provider";
import { deviceOffset } from "../../dates";
import { printQueue } from "../../print/printer";
import { usePrintJob } from "../../print/usePrintJobs";
import { queueKitchenSlip } from "../../payment/complete";
import { useApproval } from "../../staff/useApproval";
import { space, touch } from "../../theme/tokens";
import { Banner, Button, Field, Icon, Screen, Sheet } from "../../ui";

/** One saved bill: its receipt, Reprint, and Void by a manager or the owner, with a reason. */
export default function BillDetail() {
  const db = useDb();
  const { id } = useLocalSearchParams<{ id: string }>();
  const bill = useData((d) => getBill(d, id));
  const printer = useData((d) => printerFor(d, "receipt"));
  const [jobId, setJobId] = useState<string | null>(null);
  const job = usePrintJob(jobId);
  const kitchenOn = useData((d) => getCounterSettings(d).kitchenSlip !== "off");
  const [kitchenJobId, setKitchenJobId] = useState<string | null>(null);
  const [kitchenProblem, setKitchenProblem] = useState<string | null>(null);
  const kitchenJob = usePrintJob(kitchenJobId);
  const { approve, sheet } = useApproval();
  const [voidBy, setVoidBy] = useState<string | null>(null);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [justVoided, setJustVoided] = useState(false);

  if (!bill) {
    return <Screen title="Bill"><Banner tone="error" text="This bill could not be found." /><Button label="Back" onPress={() => router.back()} /></Screen>;
  }

  function reprint() {
    if (!printer || !bill) return;
    const next = uuidv7();
    printQueue.enqueue({ id: next, label: `Bill ${bill.invoiceNo}`, target: printTarget(printer), bytes: receiptSlip(bill, printer.paperWidth, printer.profile), copies: 1 });
    setJobId(next);
  }

  async function startVoid() {
    setProblem(null);
    const by = await approve("bills.refund", { title: "Void this bill" });
    if (!by) return;
    setVoidBy(by);
    setReasonOpen(true);
  }

  function reprintKitchen() {
    if (!bill) return;
    const result = queueKitchenSlip(db, bill, { enqueue: printQueue.enqueue, newId: uuidv7 }, { reprint: true });
    setKitchenJobId(result.kitchenJobId);
    setKitchenProblem(result.kitchenProblem);
  }

  function confirmVoid() {
    try {
      const now = Date.now();
      if (!voidBy) return;
      voidBill(db, { billId: id, reason, staffId: voidBy, now, tzOffsetMinutes: deviceOffset(now) });
      setReasonOpen(false);
      setReason("");
      setJustVoided(true);
    } catch (e) {
      setProblem(e instanceof BillError && e.code === "invalid_reason" ? "Give a reason of up to 120 characters."
        : e instanceof BillError && e.code === "already_void" ? "This bill is already void."
        : e instanceof BillError && e.code === "not_allowed" ? "A manager or the owner must void a bill." : "The bill could not be voided. Try again.");
    }
  }

  return (
    <Screen title={`Token ${bill.token}`} edges={["top", "bottom"]}
      actions={<Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={styles.iconKey}><Icon name="close" /></Pressable>}>
      <ReceiptView bill={bill} />
      {job && (job.state === "queued" || job.state === "printing") ? <Banner text="Printing…" /> : null}
      {job?.state === "done" ? <Banner tone="success" text="Receipt printed." /> : null}
      {job?.state === "failed" ? <Banner tone="error" text={job.error ?? "The receipt did not print."} action={{ label: "Try again", onPress: () => printQueue.retry(job.id) }} /> : null}
      {kitchenProblem ? <Banner tone="warning" text={kitchenProblem} /> : null}
      {kitchenJob?.state === "done" ? <Banner tone="success" text="Kitchen slip printed." /> : null}
      {kitchenJob?.state === "failed" ? <Banner tone="error" text={`Kitchen slip: ${kitchenJob.error ?? "it did not print."}`}
        action={{ label: "Try again", onPress: () => printQueue.retry(kitchenJob.id) }} /> : null}
      {!printer ? <Banner text="No printer set up. Add one in More, Printers." action={{ label: "Printers", onPress: () => router.push("/more/printers") }} /> : null}
      {justVoided ? <Banner tone="success" text="Bill voided. It no longer counts in the day's sales." {...(printer ? { action: { label: "Print void receipt", onPress: reprint } } : {})} /> : null}
      <View style={styles.actions}>
        <Button label="Reprint" icon="printer" size="lg" disabled={!printer} onPress={reprint} style={styles.grow} />
        {kitchenOn && !bill.voided ? <Button label="Reprint kitchen slip" variant="secondary" size="lg" onPress={reprintKitchen} /> : null}
        {!bill.voided ? <Button label="Void" variant="danger" size="lg" onPress={() => void startVoid()} /> : null}
      </View>

      {sheet}
      <Sheet visible={reasonOpen} title="Why void this bill?" onClose={() => setReasonOpen(false)}
        footer={<Button label="Void bill" variant="danger" size="lg" disabled={!reason.trim()} onPress={confirmVoid} />}>
        <Field label="Reason" value={reason} onChangeText={setReason} placeholder="Wrong order" maxLength={120} autoFocus error={problem} />
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: "row", gap: space.sm },
  grow: { flex: 1 },
  iconKey: { width: touch.min, height: touch.min, alignItems: "center", justifyContent: "center" },
});
