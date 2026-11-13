import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { getDevice, hashPin, setStaffPinHash, staffPinHash, verifyPin, type Staff } from "@masalapos/cafe-data";
import { useDb } from "../db/provider";
import { staffPinAttempts } from "../security/pin-attempts";
import { color, space, type } from "../theme/tokens";
import { Banner, Button, Keypad } from "../ui";

/**
 * Asks one person for their PIN. "Wrong PIN." allows another try; after five, that person's entry locks for 30 s,
 * doubling, and the lock is kept on the phone. A Phase 1 hash or a low iteration count is replaced on a right PIN.
 */
export function PinPad({ staff, onSuccess, onBack }: { staff: Staff; onSuccess: (staff: Staff) => void; onBack?: () => void }) {
  const db = useDb();
  const [pin, setPin] = useState("");
  const [triesLeft, setTriesLeft] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const [waitMs, setWaitMs] = useState(0);

  useEffect(() => {
    setPin("");
    setTriesLeft(null);
    const tick = () => setWaitMs(staffPinAttempts(db, staff.id).waitMs(Date.now()));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [db, staff.id]);

  async function check(entered: string) {
    const attempts = staffPinAttempts(db, staff.id);
    if (attempts.waitMs(Date.now()) > 0) return;
    setChecking(true);
    try {
      const stored = staffPinHash(db, staff.id);
      const device = getDevice(db);
      const result = stored ? await verifyPin(entered, stored, device ? { deviceId: device.id } : undefined) : { ok: false, rehash: false };
      setPin("");
      if (result.ok) {
        attempts.succeed();
        if (result.rehash) setStaffPinHash(db, staff.id, await hashPin(entered), Date.now());
        setTriesLeft(null);
        onSuccess(staff);
        return;
      }
      const failed = attempts.fail(Date.now());
      setWaitMs(attempts.waitMs(Date.now()));
      setTriesLeft(failed.locked ? null : failed.triesLeft);
    } finally {
      setChecking(false);
    }
  }

  function key(k: string) {
    if (checking || waitMs > 0) return;
    if (k === "back") return setPin((p) => p.slice(0, -1));
    if (k === "." || pin.length >= 6) return;
    setPin(pin + k);
  }

  return (
    <View style={styles.pad}>
      <Text style={[type.title, { color: color.onSurface, textAlign: "center" }]}>{staff.name}</Text>
      {waitMs > 0 ? (
        <Banner tone="error" text={`Too many wrong PINs. Try again in ${Math.ceil(waitMs / 1000)} seconds.`} />
      ) : (
        <>
          <View style={styles.dots} accessibilityLabel={`${pin.length} digits entered`}>
            {Array.from({ length: 6 }, (_, i) => <View key={i} style={[styles.dot, i < pin.length && styles.dotOn]} />)}
          </View>
          {triesLeft !== null ? (
            <Text style={[type.bodyStrong, styles.wrong]} accessibilityLiveRegion="assertive">
              Wrong PIN. {triesLeft} {triesLeft === 1 ? "try" : "tries"} left.
            </Text>
          ) : null}
          <Keypad decimal={false} onKey={key} />
        </>
      )}
      <View style={styles.enter}>
        {onBack ? <Button label="Back" variant="secondary" onPress={onBack} /> : null}
        <View style={styles.grow} />
        <Button label="OK" size="lg" disabled={pin.length < 4 || waitMs > 0} busy={checking} onPress={() => void check(pin)} style={styles.ok} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  pad: { gap: space.md, width: "100%", maxWidth: 420, alignSelf: "center" },
  dots: { flexDirection: "row", justifyContent: "center", gap: space.sm, paddingVertical: space.sm },
  dot: { width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: color.outline },
  dotOn: { backgroundColor: color.onSurface, borderColor: color.onSurface },
  wrong: { color: color.error, textAlign: "center" },
  enter: { flexDirection: "row", alignItems: "center", gap: space.sm },
  grow: { flex: 1 },
  ok: { minWidth: 120 },
});
