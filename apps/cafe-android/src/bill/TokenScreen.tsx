import { useEffect } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { CafeBill } from "@masalapos/cafe-data";
import { printQueue } from "../print/printer";
import { usePrintJob } from "../print/usePrintJobs";
import { color, radius, space, type } from "../theme/tokens";
import { Banner, Button, Money } from "../ui";

/**
 * After Paid: the token in very large type, the total, change to give and how the receipt is printing.
 * Tapping, or three seconds, returns to an empty bill. A failed print waits for Try again or a tap.
 */
export function TokenScreen({ bill, changePaise, printJobId, hasPrinter, onDone }: {
  bill: CafeBill; changePaise: number; printJobId: string | null; hasPrinter: boolean; onDone: () => void;
}) {
  const job = usePrintJob(printJobId);
  const failed = job?.state === "failed";
  useEffect(() => {
    if (failed) return;
    const timer = setTimeout(onDone, 3000);
    return () => clearTimeout(timer);
  }, [failed, onDone]);

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
          {job && (job.state === "queued" || job.state === "printing") ? <Banner text="Printing the receipt…" /> : null}
          {job?.state === "done" ? <Banner tone="success" text="Receipt printed." /> : null}
          {failed ? <Banner tone="error" text={job.error ?? "The receipt did not print."} action={{ label: "Try again", onPress: () => printQueue.retry(job.id) }} /> : null}
        </View>
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
});
