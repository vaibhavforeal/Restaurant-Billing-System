import { useState, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { daySummary, getCafe, printerFor, printTarget } from "@masalapos/cafe-data";
import { uuidv7 } from "@masalapos/domain/id";
import { useData } from "../../db/provider";
import { today } from "../../dates";
import { daySummarySlip } from "../../print/day-summary-slip";
import { printQueue } from "../../print/printer";
import { usePrintJob } from "../../print/usePrintJobs";
import { color, radius, space, type } from "../../theme/tokens";
import { Banner, Button, DateControl, Money, Screen, useLayout } from "../../ui";
import { useScreenGate } from "../../staff/useApproval";

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.stat}>
      <Text style={[type.label, { color: color.onSurfaceMuted }]}>{label}</Text>
      {children}
    </View>
  );
}

function Line({ label, paise, note }: { label: string; paise: number; note?: string }) {
  return (
    <View style={styles.line}>
      <View style={styles.grow}>
        <Text style={[type.body, { color: color.onSurface }]}>{label}</Text>
        {note ? <Text style={[type.caption, { color: color.onSurfaceMuted }]}>{note}</Text> : null}
      </View>
      <Money paise={paise} />
    </View>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.card}>
      <Text style={[type.title, { color: color.onSurface }]} accessibilityRole="header">{title}</Text>
      {children}
    </View>
  );
}

/** The day report: sales, payment modes, tax by rate, items sold and voids; printable as a slip. */
function ReportsScreen() {
  const [date, setDate] = useState(today);
  const s = useData((db) => daySummary(db, date));
  const cafeName = useData((db) => getCafe(db)?.name ?? "");
  const printer = useData((db) => printerFor(db, "receipt"));
  const { tablet } = useLayout();
  const [jobId, setJobId] = useState<string | null>(null);
  const job = usePrintJob(jobId);

  function print() {
    if (!printer) return;
    const id = uuidv7();
    printQueue.enqueue({ id, label: `Day summary ${date}`, target: printTarget(printer), bytes: daySummarySlip(s, cafeName, printer.paperWidth, printer.profile), copies: 1 });
    setJobId(id);
  }

  const empty = s.billCount === 0 && s.voidCount === 0;
  return (
    <Screen title="Reports" actions={!empty && printer ? <Button label="Print summary" icon="printer" variant="secondary" onPress={print} /> : null}>
      <DateControl value={date} onChange={setDate} />
      {job && job.state !== "done" && job.state !== "failed" ? <Banner text="Printing the summary…" /> : null}
      {job?.state === "done" ? <Banner tone="success" text="Summary printed." /> : null}
      {job?.state === "failed" ? <Banner tone="error" text={job.error ?? "The summary did not print."} action={{ label: "Try again", onPress: () => printQueue.retry(job.id) }} /> : null}
      {!printer && !empty ? <Banner text="Add a printer in More, Printers, to print this summary." action={{ label: "Printers", onPress: () => router.push("/more/printers") }} /> : null}
      {empty ? <Text style={[type.body, { color: color.onSurfaceMuted }]}>No bills on this day.</Text> : (
        <>
          <View style={[styles.stats, tablet && styles.statsWide]}>
            <Stat label="Net sales"><Money paise={s.netPaise} size="headline" /></Stat>
            <Stat label="Bills"><Text style={[type.headline, { color: color.onSurface }]}>{s.billCount}</Text></Stat>
            <Stat label="Discounts"><Money paise={s.discountPaise} size="headline" /></Stat>
            <Stat label="Voids"><Text style={[type.headline, { color: color.onSurface }]}>{s.voidCount}</Text></Stat>
          </View>
          <Card title="Payments">
            <Line label="Cash" paise={s.byMode.cash} />
            <Line label="UPI" paise={s.byMode.upi} />
            <Line label="Card" paise={s.byMode.card} />
          </Card>
          <Card title="Sales">
            <Line label="Gross sales" paise={s.grossPaise} />
            <Line label="Discounts" paise={-s.discountPaise} />
            {s.roundingPaise ? <Line label="Round off" paise={s.roundingPaise} /> : null}
            <Line label="Net sales" paise={s.netPaise} />
          </Card>
          {s.taxes.some((t) => t.cgstPaise || t.sgstPaise) ? (
            <Card title="Tax by rate">
              {s.taxes.map((t) => (
                <Line key={t.gstRate} label={`GST ${t.gstRate}%`} paise={t.cgstPaise + t.sgstPaise}
                  note={`Taxable ₹${(t.taxablePaise / 100).toFixed(2)} · CGST ₹${(t.cgstPaise / 100).toFixed(2)} · SGST ₹${(t.sgstPaise / 100).toFixed(2)}`} />
              ))}
            </Card>
          ) : null}
          {s.items.length ? (
            <Card title="Items sold">
              {s.items.map((i) => <Line key={i.name} label={i.name} paise={i.amountPaise} note={`${i.qty} sold`} />)}
            </Card>
          ) : null}
          {s.voids.length ? (
            <Card title="Voids">
              {s.voids.map((v) => <Line key={v.invoiceNo} label={`${v.invoiceNo} · Token ${v.token}`} paise={v.totalPaise} note={v.reason} />)}
            </Card>
          ) : null}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  stats: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  statsWide: { flexWrap: "nowrap" },
  stat: { flexGrow: 1, flexBasis: "45%", backgroundColor: color.surface, borderRadius: radius.md, borderWidth: 1, borderColor: color.outlineVariant,
    padding: space.md, gap: space.xxs },
  card: { backgroundColor: color.surface, borderRadius: radius.md, borderWidth: 1, borderColor: color.outlineVariant, padding: space.md, gap: space.xs },
  line: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 32 },
  grow: { flex: 1 },
});

/** Reports need a manager or the owner, asked once on entry. */
export default function ReportsTab() {
  const { allowed, sheet } = useScreenGate("reports.read", "Open reports");
  return <>{allowed ? <ReportsScreen /> : <Screen title="Reports"><></></Screen>}{sheet}</>;
}
