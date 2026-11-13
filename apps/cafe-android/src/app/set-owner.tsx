import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Redirect, router } from "expo-router";
import { addStaff, getCafe, hasActiveOwner, hashPin, isValidPin } from "@masalapos/cafe-data";
import { useDb, useData } from "../db/provider";
import { session } from "../staff/session";
import { color, space, type } from "../theme/tokens";
import { Banner, Button, Field, Screen } from "../ui";

/** The cafe exists but has no active owner (set-up was interrupted): make one before anything else. */
export default function SetOwner() {
  const db = useDb();
  const hasCafe = useData((d) => getCafe(d) !== null);
  const [ownerExists] = useState(() => hasActiveOwner(db));
  const [name, setName] = useState("Owner");
  const [pin, setPin] = useState("");
  const [pinAgain, setPinAgain] = useState("");
  const [errors, setErrors] = useState<{ name?: string; pin?: string; pinAgain?: string }>({});
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  if (!hasCafe) return <Redirect href="/first-run" />;
  if (ownerExists) return <Redirect href="/lock" />;

  async function save() {
    const next: typeof errors = {};
    if (!name.trim() || name.trim().length > 30) next.name = "Enter a name of up to 30 characters";
    if (!isValidPin(pin)) next.pin = "Use 4 to 6 digits";
    else if (pin !== pinAgain) next.pinAgain = "The two PINs are different";
    setErrors(next);
    if (Object.keys(next).length) return;
    setSaving(true);
    setFailure(null);
    try {
      const owner = addStaff(db, { name, role: "owner", pinHash: await hashPin(pin) }, Date.now());
      session.signIn(owner);
      router.replace("/bill");
    } catch (e) {
      setFailure(e instanceof Error ? e.message : "The owner could not be saved. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Screen title="Set owner PIN" edges={["top", "bottom"]}>
      <Text style={[type.body, { color: color.onSurfaceMuted }]}>
        This cafe has no owner yet. The owner adds staff, changes settings and can void bills.
      </Text>
      <View style={styles.form}>
        <Field label="Your name" value={name} onChangeText={setName} error={errors.name ?? null} autoCapitalize="words" maxLength={30} />
        <Field label="Owner PIN" help="4 to 6 digits" value={pin} onChangeText={setPin} error={errors.pin ?? null}
          keyboardType="number-pad" secureTextEntry maxLength={6} />
        <Field label="Owner PIN again" value={pinAgain} onChangeText={setPinAgain} error={errors.pinAgain ?? null}
          keyboardType="number-pad" secureTextEntry maxLength={6} />
        {failure ? <Banner tone="error" text={failure} /> : null}
        <Button label="Save and start" size="lg" busy={saving} onPress={() => void save()} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  form: { gap: space.md },
});
