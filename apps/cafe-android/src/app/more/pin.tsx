import { useState } from "react";
import { getDevice, ownerPinHash, setOwnerPinHash } from "@masalapos/cafe-data";
import { useDb } from "../../db/provider";
import { hashPin, isValidPin } from "../../security/pin";
import { ownerPinAttempts } from "../../security/pin-attempts";
import { Banner, Button, Field, Screen } from "../../ui";

/** Changes the owner PIN: the current PIN, then the new one twice. */
export default function OwnerPin() {
  const db = useDb();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [errors, setErrors] = useState<{ current?: string; next?: string; again?: string }>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function change() {
    setDone(false);
    const found: typeof errors = {};
    if (!isValidPin(next)) found.next = "Use 4 to 6 digits";
    else if (next !== again) found.again = "The two new PINs are different";
    const wait = ownerPinAttempts(db).waitMs(Date.now());
    if (wait > 0) return setErrors({ current: `Too many wrong PINs. Try again in ${Math.ceil(wait / 1000)} seconds.` });
    const device = getDevice(db);
    setBusy(true);
    const currentOk = device !== null && (await hashPin(current, device.id)) === ownerPinHash(db);
    if (currentOk) ownerPinAttempts(db).succeed();
    else found.current = ownerPinAttempts(db).fail(Date.now()).locked ? "Wrong PIN. PIN entry is locked for a while." : "Wrong PIN.";
    setErrors(found);
    if (!Object.keys(found).length && device) {
      setOwnerPinHash(db, await hashPin(next, device.id), Date.now());
      setCurrent(""); setNext(""); setAgain("");
      setDone(true);
    }
    setBusy(false);
  }

  const pinField = { keyboardType: "number-pad", secureTextEntry: true, maxLength: 6 } as const;
  return (
    <Screen title="Owner PIN" edges={["top", "bottom"]}>
      <Field label="Current PIN" value={current} onChangeText={setCurrent} error={errors.current ?? null} {...pinField} />
      <Field label="New PIN" value={next} onChangeText={setNext} error={errors.next ?? null} help="4 to 6 digits. You need it to void a bill." {...pinField} />
      <Field label="New PIN again" value={again} onChangeText={setAgain} error={errors.again ?? null} {...pinField} />
      {done ? <Banner tone="success" text="Owner PIN changed." /> : null}
      <Button label="Change PIN" size="lg" busy={busy} disabled={!current || !next || !again} onPress={() => void change()} />
    </Screen>
  );
}
