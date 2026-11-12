import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Redirect, router } from "expo-router";
import { CafeSettingsInput, getCafe, getDevice, saveCafe, seedSampleMenu, setOwnerPinHash, type CafeSettings } from "@masalapos/cafe-data";
import { useDb } from "../db/provider";
import { hashPin, isValidPin } from "../security/pin";
import { color, radius, space, type } from "../theme/tokens";
import { Banner, Button, Field, Screen } from "../ui";
import { Choice } from "../ui/Choice";
import { PrinterSetup } from "../print/PrinterSetup";

type Step = "cafe" | "menu" | "printer";
type FieldErrors = Partial<Record<keyof CafeSettings | "pin" | "pinAgain", string>>;

const GST_MODE_OPTIONS = [
  { value: "included", label: "Prices include GST" },
  { value: "exclusive", label: "GST added on top" },
  { value: "none", label: "No GST" },
] as const;
const RATE_OPTIONS = [0, 5, 12, 18, 28].map((r) => ({ value: r, label: `${r}%` }));

/** Three steps: the cafe and owner PIN, an empty or sample menu, then a printer (which can be skipped). */
export default function FirstRun() {
  const db = useDb();
  const [step, setStep] = useState<Step>("cafe");
  const [form, setForm] = useState({ name: "", address: "", phone: "", gstin: "", gstMode: "included" as CafeSettings["gstMode"], defaultGstRate: 5 });
  const [pin, setPin] = useState("");
  const [pinAgain, setPinAgain] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [sampleMenu, setSampleMenu] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // Set-up happens once. Reaching this screen again (a link, a back gesture) must not reset the cafe or its owner PIN.
  const [alreadySetUp] = useState(() => getCafe(db) !== null);

  const settings = () => ({ ...form, fssai: "", roundOff: "rupee", invoicePrefix: "", receiptHeader: "", receiptFooter: "", receiptStyle: "classic", upiId: "" });

  function checkCafe() {
    const parsed = CafeSettingsInput.safeParse(settings());
    const next: FieldErrors = {};
    if (!parsed.success) for (const issue of parsed.error.issues) next[issue.path[0] as keyof CafeSettings] ??= issue.message;
    if (!isValidPin(pin)) next.pin = "Use 4 to 6 digits";
    else if (pin !== pinAgain) next.pinAgain = "The two PINs are different";
    setErrors(next);
    if (Object.keys(next).length === 0) setStep("menu");
  }

  /** Saves the cafe, PIN and menu choice once; the printer step needs the cafe saved to print its name. */
  async function save(): Promise<boolean> {
    if (saved) return true;
    setSaving(true);
    setFailure(null);
    try {
      const now = Date.now();
      saveCafe(db, settings(), now);
      setOwnerPinHash(db, await hashPin(pin, getDevice(db)!.id), now);
      if (sampleMenu) seedSampleMenu(db, now);
      setSaved(true);
      return true;
    } catch (e) {
      setFailure(e instanceof Error ? e.message : "The cafe could not be saved. Try again.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function finish() {
    if (await save()) router.replace("/bill");
  }

  if (alreadySetUp) return <Redirect href="/bill" />;

  const set = (key: keyof typeof form) => (value: string | number) => setForm((f) => ({ ...f, [key]: value }));

  return (
    <Screen title="Set up your cafe" edges={["top", "bottom"]}>
      <Text style={[type.small, { color: color.onSurfaceMuted }]}>Step {step === "cafe" ? 1 : step === "menu" ? 2 : 3} of 3</Text>
      {step === "cafe" && (
        <View style={styles.form}>
          <Field label="Cafe name" value={form.name} onChangeText={set("name")} error={errors.name ?? null} autoCapitalize="words" maxLength={60} />
          <Field label="Address (optional)" value={form.address} onChangeText={set("address")} error={errors.address ?? null} multiline />
          <Field label="Phone (optional)" value={form.phone} onChangeText={set("phone")} error={errors.phone ?? null} keyboardType="phone-pad" maxLength={20} />
          <Field label="GSTIN (optional)" value={form.gstin} onChangeText={set("gstin")} error={errors.gstin ?? null} autoCapitalize="characters" maxLength={15} />
          <Choice label="Tax" options={GST_MODE_OPTIONS} value={form.gstMode} onChange={set("gstMode")} />
          {form.gstMode !== "none" && <Choice label="Usual GST rate" options={RATE_OPTIONS} value={form.defaultGstRate} onChange={set("defaultGstRate")} />}
          <Field label="Owner PIN" help="4 to 6 digits. You need it to void a bill." value={pin} onChangeText={setPin} error={errors.pin ?? null}
            keyboardType="number-pad" secureTextEntry maxLength={6} />
          <Field label="Owner PIN again" value={pinAgain} onChangeText={setPinAgain} error={errors.pinAgain ?? null} keyboardType="number-pad" secureTextEntry maxLength={6} />
          <Button label="Next" size="lg" onPress={checkCafe} />
        </View>
      )}
      {step === "menu" && (
        <View style={styles.form}>
          <Text style={[type.title, { color: color.onSurface }]}>How do you want to start?</Text>
          {[
            { sample: false, title: "Start with an empty menu", text: "Add your own items, or bill any amount with Custom item." },
            { sample: true, title: "Add a sample menu", text: "Tea, coffee and snacks to try the app with. Edit or delete them later." },
          ].map((o) => (
            <Button key={o.title} label={o.title} variant={sampleMenu === o.sample ? "primary" : "secondary"} onPress={() => setSampleMenu(o.sample)}
              accessibilityHint={o.text} style={styles.option} />
          ))}
          <Text style={[type.small, { color: color.onSurfaceMuted }]}>
            {sampleMenu ? "Tea, coffee and snacks to try the app with. Edit or delete them later." : "Add your own items, or bill any amount with Custom item."}
          </Text>
          <View style={styles.actions}>
            <Button label="Back" variant="secondary" onPress={() => setStep("cafe")} />
            <Button label="Next" size="lg" onPress={() => setStep("printer")} style={styles.grow} />
          </View>
        </View>
      )}
      {step === "printer" && (
        <View style={styles.form}>
          <Text style={[type.title, { color: color.onSurface }]}>Receipt printer</Text>
          <Text style={[type.body, { color: color.onSurfaceMuted }]}>You can add a printer later in More, Printers. Bills are saved either way.</Text>
          {saved ? <PrinterSetup /> : <Button label="Set up a printer now" variant="secondary" busy={saving} onPress={() => void save()} />}
          {failure ? <Banner tone="error" text={failure} /> : null}
          <View style={styles.actions}>
            {saved ? null : <Button label="Back" variant="secondary" onPress={() => setStep("menu")} />}
            <Button label={saved ? "Start billing" : "Skip and start billing"} size="lg" busy={saving} onPress={() => void finish()} style={styles.grow} />
          </View>
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  form: { gap: space.md },
  option: { minHeight: 64, borderRadius: radius.md },
  actions: { flexDirection: "row", gap: space.sm, marginTop: space.sm },
  grow: { flex: 1 },
});
