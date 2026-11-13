import { StyleSheet, Text, View } from "react-native";
import { getCounterSettings, printerFor, saveCounterSettings, type CounterSettings } from "@masalapos/cafe-data";
import { useDb, useData } from "../../db/provider";
import { PrinterSetup } from "../../print/PrinterSetup";
import { useApproval, useScreenGate } from "../../staff/useApproval";
import { color, space, type } from "../../theme/tokens";
import { Banner, Choice, Screen } from "../../ui";

const SLIP = [{ value: "off", label: "No kitchen slip" }, { value: "kitchen", label: "Kitchen printer" }, { value: "receipt", label: "Receipt printer" }] as const;

/** The receipt printer, a kitchen printer, and where the kitchen slip prints. A manager or the owner is asked on entry. */
function Printers() {
  const db = useDb();
  const { approve, sheet } = useApproval();
  const slip = useData((d) => getCounterSettings(d).kitchenSlip);
  const hasKitchen = useData((d) => printerFor(d, "kitchen") !== null);

  async function choose(next: CounterSettings["kitchenSlip"]) {
    if (next === slip || (next === "kitchen" && !hasKitchen)) return;
    const by = await approve("settings.manage", { title: "Change the kitchen slip", always: true });
    if (by) saveCounterSettings(db, { ...getCounterSettings(db), kitchenSlip: next }, Date.now());
  }

  return (
    <>
      <Text style={[type.title, styles.heading]} accessibilityRole="header">Receipt printer</Text>
      <PrinterSetup />
      <Text style={[type.title, styles.heading]} accessibilityRole="header">Kitchen slip</Text>
      <Text style={[type.body, { color: color.onSurfaceMuted }]}>
        After Paid, a slip with the token, each item and its note prints for the kitchen, after the receipt.
      </Text>
      <Choice options={SLIP} value={slip} onChange={(v) => void choose(v)} />
      {!hasKitchen ? <Banner text="Kitchen printer needs a printer with the kitchen role. Add one below." /> : null}
      {slip === "kitchen" && !hasKitchen ? <Banner tone="warning" text="No kitchen printer. Kitchen slips will not print until you add one." /> : null}
      <View style={styles.gap} />
      <Text style={[type.title, styles.heading]} accessibilityRole="header">Kitchen printer</Text>
      <PrinterSetup role="kitchen" />
      {sheet}
    </>
  );
}

export default function PrintersScreen() {
  const { allowed, sheet } = useScreenGate("printers.manage", "Change printers");
  return (
    <Screen title="Printers" edges={["top", "bottom"]}>
      {allowed ? <Printers /> : null}
      {sheet}
    </Screen>
  );
}

const styles = StyleSheet.create({
  heading: { color: color.onSurface },
  gap: { height: space.sm },
});
