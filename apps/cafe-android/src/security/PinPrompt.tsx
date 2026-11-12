import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { getDevice, ownerPinHash } from "@masalapos/cafe-data";
import { useDb } from "../db/provider";
import { color, space, type } from "../theme/tokens";
import { Button, Keypad, Sheet } from "../ui";
import { hashPin } from "./pin";

const MAX_TRIES = 5;

/** Asks for the owner PIN. "Wrong PIN." allows another try; five wrong tries close the prompt. */
export function PinPrompt({ visible, title, onSuccess, onClose }: { visible: boolean; title: string; onSuccess: () => void; onClose: () => void }) {
  const db = useDb();
  const [pin, setPin] = useState("");
  const [wrong, setWrong] = useState(0);
  const [checking, setChecking] = useState(false);

  function close() { setPin(""); setWrong(0); onClose(); }

  async function check(entered: string) {
    setChecking(true);
    const device = getDevice(db);
    const ok = device !== null && (await hashPin(entered, device.id)) === ownerPinHash(db);
    setChecking(false);
    setPin("");
    if (ok) { setWrong(0); onSuccess(); return; }
    if (wrong + 1 >= MAX_TRIES) { close(); return; }
    setWrong(wrong + 1);
  }

  function key(k: string) {
    if (checking) return;
    if (k === "back") return setPin((p) => p.slice(0, -1));
    if (k === "." || pin.length >= 6) return;
    setPin(pin + k);
  }

  return (
    <Sheet visible={visible} title={title} onClose={close}>
      <Text style={[type.body, { color: color.onSurfaceMuted }]}>Enter the owner PIN.</Text>
      <View style={styles.dots} accessibilityLabel={`${pin.length} digits entered`}>
        {Array.from({ length: 6 }, (_, i) => <View key={i} style={[styles.dot, i < pin.length && styles.dotOn]} />)}
      </View>
      {wrong > 0 ? <Text style={[type.bodyStrong, styles.wrong]} accessibilityLiveRegion="assertive">Wrong PIN. {MAX_TRIES - wrong} {MAX_TRIES - wrong === 1 ? "try" : "tries"} left.</Text> : null}
      <Keypad decimal={false} onKey={key} />
      <View style={styles.enter}>
        <Text style={[type.small, { color: color.onSurfaceMuted, flex: 1 }]}>4 to 6 digits</Text>
        <Button label="OK" size="lg" disabled={pin.length < 4} busy={checking} onPress={() => void check(pin)} style={styles.ok} />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  dots: { flexDirection: "row", justifyContent: "center", gap: space.sm, paddingVertical: space.sm },
  dot: { width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: color.outline },
  dotOn: { backgroundColor: color.onSurface, borderColor: color.onSurface },
  wrong: { color: color.error, textAlign: "center" },
  enter: { flexDirection: "row", alignItems: "center" },
  ok: { minWidth: 120 },
});
