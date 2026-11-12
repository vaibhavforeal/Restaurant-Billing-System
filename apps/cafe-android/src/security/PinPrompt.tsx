import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { getDevice, ownerPinHash } from "@masalapos/cafe-data";
import { useDb } from "../db/provider";
import { color, space, type } from "../theme/tokens";
import { Banner, Button, Keypad, Sheet } from "../ui";
import { hashPin } from "./pin";
import { ownerPinAttempts } from "./pin-attempts";

/**
 * Asks for the owner PIN. "Wrong PIN." allows another try; the fifth wrong try closes the prompt and locks PIN entry
 * for a while (the count survives closing the prompt, so it cannot be reset by reopening it).
 */
export function PinPrompt({ visible, title, onSuccess, onClose }: { visible: boolean; title: string; onSuccess: () => void; onClose: () => void }) {
  const db = useDb();
  const [pin, setPin] = useState("");
  const [triesLeft, setTriesLeft] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const [waitMs, setWaitMs] = useState(0);

  useEffect(() => {
    if (!visible) return;
    const tick = () => setWaitMs(ownerPinAttempts.waitMs(Date.now()));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [visible]);

  function close() { setPin(""); setTriesLeft(null); onClose(); }

  async function check(entered: string) {
    if (ownerPinAttempts.waitMs(Date.now()) > 0) return;
    setChecking(true);
    const device = getDevice(db);
    const ok = device !== null && (await hashPin(entered, device.id)) === ownerPinHash(db);
    setChecking(false);
    setPin("");
    if (ok) { ownerPinAttempts.succeed(); setTriesLeft(null); onSuccess(); return; }
    const result = ownerPinAttempts.fail(Date.now());
    if (result.locked) { close(); return; }
    setTriesLeft(result.triesLeft);
  }

  function key(k: string) {
    if (checking || waitMs > 0) return;
    if (k === "back") return setPin((p) => p.slice(0, -1));
    if (k === "." || pin.length >= 6) return;
    setPin(pin + k);
  }

  return (
    <Sheet visible={visible} title={title} onClose={close}>
      {waitMs > 0 ? (
        <Banner tone="error" text={`Too many wrong PINs. Try again in ${Math.ceil(waitMs / 1000)} seconds.`} />
      ) : (
        <>
          <Text style={[type.body, { color: color.onSurfaceMuted }]}>Enter the owner PIN.</Text>
          <View style={styles.dots} accessibilityLabel={`${pin.length} digits entered`}>
            {Array.from({ length: 6 }, (_, i) => <View key={i} style={[styles.dot, i < pin.length && styles.dotOn]} />)}
          </View>
          {triesLeft !== null ? (
            <Text style={[type.bodyStrong, styles.wrong]} accessibilityLiveRegion="assertive">
              Wrong PIN. {triesLeft} {triesLeft === 1 ? "try" : "tries"} left.
            </Text>
          ) : null}
          <Keypad decimal={false} onKey={key} />
          <View style={styles.enter}>
            <Text style={[type.small, { color: color.onSurfaceMuted, flex: 1 }]}>4 to 6 digits</Text>
            <Button label="OK" size="lg" disabled={pin.length < 4} busy={checking} onPress={() => void check(pin)} style={styles.ok} />
          </View>
        </>
      )}
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
