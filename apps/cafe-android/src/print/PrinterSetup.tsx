import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { uuidv7 } from "@masalapos/domain/id";
import { deletePrinter, getCafe, printerFor, printTarget, savePrinter, type Printer } from "@masalapos/cafe-data";
import { useDb, useData } from "../db/provider";
import { color, radius, space, type } from "../theme/tokens";
import { Banner, Button, Choice, Field, ListRow } from "../ui";
import { bluetoothState, openBluetoothSettings, pairedPrinters, printQueue, requestBluetoothPermission } from "./printer";
import { printErrorMessage } from "./print-queue";
import { testSlip } from "./test-slip";
import { usePrintJob } from "./usePrintJobs";

type Mode = { kind: "idle" } | { kind: "bluetooth"; devices: Array<{ name: string; address: string }>; chosen: { name: string; address: string } | null }
  | { kind: "network" };

const PAPER = [{ value: 58, label: "58 mm" }, { value: 80, label: "80 mm" }] as const;

/** The receipt (or kitchen) printer: add one over Bluetooth or the network, choose the paper width, print a test slip. */
export function PrinterSetup({ role = "receipt" }: { role?: "receipt" | "kitchen" }) {
  const db = useDb();
  const printer = useData((d) => printerFor(d, role));
  const cafeName = useData((d) => getCafe(d)?.name ?? "MasalaPOS Cafe");
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [paper, setPaper] = useState<58 | 80>(58);
  const [address, setAddress] = useState("");
  const [problem, setProblem] = useState<{ text: string; settings?: boolean } | null>(null);
  const [testJob, setTestJob] = useState<string | null>(null);
  const job = usePrintJob(testJob);

  async function startBluetooth() {
    setProblem(null);
    let state = await bluetoothState();
    if (state === "no_permission" && await requestBluetoothPermission()) state = await bluetoothState();
    if (state === "no_permission") return setProblem({ text: printErrorMessage("NO_PERMISSION") });
    if (state === "unsupported") return setProblem({ text: "This device has no Bluetooth. Add a network printer instead." });
    if (state === "off") return setProblem({ text: printErrorMessage("BLUETOOTH_OFF"), settings: true });
    try {
      setMode({ kind: "bluetooth", devices: await pairedPrinters(), chosen: null });
    } catch (e) {
      setProblem({ text: printErrorMessage(typeof e === "object" && e && "code" in e ? String(e.code) : "") });
    }
  }

  function save(input: Pick<Printer, "name" | "transport" | "address">) {
    try {
      const saved = savePrinter(db, { ...input, paperWidth: paper, role });
      setMode({ kind: "idle" });
      setProblem(null);
      testPrint(saved);
    } catch (e) {
      setProblem({ text: e instanceof Error ? e.message : "Check the printer address." });
    }
  }

  function testPrint(p: Printer) {
    const id = uuidv7();
    printQueue.enqueue({ id, label: "Printer test", target: printTarget(p), bytes: testSlip(cafeName, p.paperWidth, Date.now()), copies: 1 });
    setTestJob(id);
  }

  return (
    <View style={styles.wrap}>
      {printer ? (
        <View style={styles.card}>
          <ListRow title={printer.name} subtitle={`${printer.transport === "bluetooth" ? "Bluetooth" : "Network"} · ${printer.address} · ${printer.paperWidth} mm`} />
          <View style={styles.actions}>
            <Button label="Test print" icon="printer" onPress={() => testPrint(printer)} style={styles.grow} />
            <Button label="Remove" variant="danger" onPress={() => { deletePrinter(db, printer.id); setTestJob(null); }} />
          </View>
        </View>
      ) : (
        <Text style={[type.body, { color: color.onSurfaceMuted }]}>No printer set up. Bills are still saved and can be printed later from Bills.</Text>
      )}

      {job && job.state !== "done" && job.state !== "failed" ? <Banner text="Printing the test slip…" /> : null}
      {job?.state === "done" ? <Banner tone="success" text="Test slip sent. If the line of numbers fits on one line, the paper width is right." /> : null}
      {job?.state === "failed" ? <Banner tone="error" text={job.error ?? printErrorMessage("")} action={{ label: "Try again", onPress: () => printQueue.retry(job.id) }} /> : null}
      {problem ? (
        <Banner tone="error" text={problem.text} {...(problem.settings ? { action: { label: "Bluetooth settings", onPress: () => void openBluetoothSettings() } } : {})} />
      ) : null}

      {mode.kind === "idle" && (
        <View style={styles.actions}>
          <Button label={printer ? "Change to Bluetooth" : "Add Bluetooth printer"} variant="secondary" onPress={() => void startBluetooth()} style={styles.grow} />
          <Button label={printer ? "Change to network" : "Add network printer"} variant="secondary" onPress={() => { setProblem(null); setMode({ kind: "network" }); }} style={styles.grow} />
        </View>
      )}

      {mode.kind === "bluetooth" && (
        <View style={styles.card}>
          <Text style={[type.small, styles.pad, { color: color.onSurfaceMuted }]}>
            Pair the printer in Android's Bluetooth settings first (its PIN is often 0000 or 1234), then come back and choose it here.
          </Text>
          <View style={styles.pad}><Button label="Open Bluetooth settings" variant="quiet" onPress={() => void openBluetoothSettings()} /></View>
          {mode.devices.length === 0 ? <Text style={[type.body, styles.pad, { color: color.onSurface }]}>No paired devices yet.</Text> : null}
          {mode.devices.map((d) => (
            <ListRow key={d.address} title={d.name} subtitle={d.address} onPress={() => setMode({ ...mode, chosen: d })}
              trailing={mode.chosen?.address === d.address ? <Text style={[type.label, { color: color.primaryInk }]}>Chosen</Text> : null} />
          ))}
          <View style={styles.pad}>
            <Choice label="Paper width" options={PAPER} value={paper} onChange={setPaper} />
          </View>
          <View style={[styles.actions, styles.pad]}>
            <Button label="Cancel" variant="secondary" onPress={() => setMode({ kind: "idle" })} />
            <Button label="Save and test" disabled={!mode.chosen} style={styles.grow}
              onPress={() => mode.chosen && save({ name: mode.chosen.name, transport: "bluetooth", address: mode.chosen.address })} />
          </View>
          <View style={styles.pad}><Button label="Look again" variant="quiet" onPress={() => void startBluetooth()} /></View>
        </View>
      )}

      {mode.kind === "network" && (
        <View style={[styles.card, styles.pad, { gap: space.md }]}>
          <Field label="Printer address" help="The printer's IP address, such as 192.168.1.50. Add :port if it is not 9100." value={address}
            onChangeText={setAddress} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
          <Choice label="Paper width" options={PAPER} value={paper} onChange={setPaper} />
          <View style={styles.actions}>
            <Button label="Cancel" variant="secondary" onPress={() => setMode({ kind: "idle" })} />
            <Button label="Save and test" disabled={!address.trim()} style={styles.grow} onPress={() => save({ name: `Network ${address.trim()}`, transport: "network", address })} />
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.md },
  card: { backgroundColor: color.surface, borderRadius: radius.md, borderWidth: 1, borderColor: color.outlineVariant, overflow: "hidden", paddingBottom: space.sm },
  actions: { flexDirection: "row", gap: space.sm, flexWrap: "wrap" },
  grow: { flexGrow: 1 },
  pad: { paddingHorizontal: space.md, paddingTop: space.sm },
});
