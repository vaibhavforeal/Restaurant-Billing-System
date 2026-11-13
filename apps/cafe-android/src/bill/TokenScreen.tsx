import { useEffect } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { CafeBill } from "@masalapos/cafe-data";
import { printQueue } from "../print/printer";
import { usePrintJob } from "../print/usePrintJobs";
import { color, radius, space, type } from "../theme/tokens";
import { Banner, Button, Money } from "../ui";
import { ReceiptView } from "./ReceiptView";

/**
 * After Paid: the token in very large type, the total, change to give and how the receipt and kitchen slip are printing,
 * each with its own Try again.
 * Tapping, or three seconds, returns to an empty bill. A failed print waits for Try again or a tap. With no printer the
 * receipt is shown on screen instead, and the screen waits for Next bill.
 */
export function TokenScreen({ bill, changePaise, printJobId, hasPrinter, printError, kitchenJobId, kitchenProblem, onDone }: {
  bill: CafeBill; changePaise: number; printJobId: string | null; hasPrinter: boolean; printError: string | null;
  kitchenJobId: string | null; kitchenProblem: string | null; onDone: () => void;
}) {
  const job = usePrintJob(printJobId);
  const kitchenJob = usePrintJob(kitchenJobId);
  const failed = job?.state === "failed" || printError !== null || kitchenJob?.state === "failed" || kitchenProblem !== null;
  useEffect(() => {
    if (failed || !hasPrinter) return;
    const timer = setTimeout(onDone, 3000);
    return () => clearTimeout(timer);
  }, [failed, hasPrinter, onDone]);

  return (
    <Pressable style={styles.fill} onPress={onDone} accessibilityRole="button" accessibilityLabel={`Token ${bill.token}. Tap for the next bill`}>
      <SafeAreaView style={styles.inner}>
        <Text style={[type.title, { color: color.onPrimaryStrong }]}>Token</Text>
        <Text style={[type.token, styles.token]} accessibilityRole="header">{bill.token}</Text>
        <View style={styles.card}>
          <View style={styles.row}><Text style={[type.body, styles.label]}>Total</Text><Money paise={bill.totalPaise} size="title" /></View>
          {changePaise > 0 ? <View style={styles.row}><Text style={[type.body, styles.label]}>Change to give</Text><Money paise={changePaise} size="headline" /></View> : null}
          <Text style={[type.small, { color: color.onSurfaceMuted }]}>{bill.invoiceNo}</Text>
          {!hasPrinter ? <Banner text="No printer set up. This bill is saved in Bills." /> : null}
          {printError ? <Banner tone="error" text={printError} /> : null}
          {job && (job.state === "queued" || job.state === "printing") ? <Banner text="Printing the receipt…" /> : null}
          {job?.state === "done" ? <Banner tone="success" text="Receipt printed." /> : null}
          {job?.state === "failed" ? <Banner tone="error" text={job.error ?? "The receipt did not print."} action={{ label: "Try again", onPress: () => printQueue.retry(job.id) }} /> : null}
          {kitchenProblem ? <Banner tone="warning" text={kitchenProblem} /> : null}
          {kitchenJob && (kitchenJob.state === "queued" || kitchenJob.state === "printing") ? <Banner text="Printing the kitchen slip…" /> : null}
          {kitchenJob?.state === "done" ? <Banner tone="success" text="Kitchen slip printed." /> : null}
          {kitchenJob?.state === "failed" ? (
            <Banner tone="error" text={`Kitchen slip: ${kitchenJob.error ?? "it did not print."}`} action={{ label: "Try again", onPress: () => printQueue.retry(kitchenJob.id) }} />
          ) : null}
        </View>
        {!hasPrinter ? <ScrollView style={styles.receipt}><ReceiptView bill={bill} /></ScrollView> : null}
        <Button label="Next bill" size="lg" variant="secondary" onPress={onDone} style={styles.next} />
      </SafeAreaView>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { ...StyleSheet.absoluteFill, backgroundColor: color.primaryStrong, zIndex: 10 },
  inner: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.lg, gap: space.md },
  token: { color: color.onPrimaryStrong, fontSize: 128, lineHeight: 136 },
  card: { maxWidth: 480, width: "100%", alignSelf: "center", backgroundColor: color.surface, borderRadius: radius.lg, padding: space.md, gap: space.sm },
  row: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
  label: { color: color.onSurfaceMuted },
  next: { minWidth: 240 },
  receipt: { maxWidth: 480, width: "100%", alignSelf: "center", maxHeight: 360 },
});
