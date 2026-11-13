import { useState } from "react";
import { Alert, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import {
  CAFE_ROLES, StaffError, addStaff, hashPin, isValidPin, listStaff, setStaffPinHash, updateStaff, type CafeRole, type Staff,
} from "@masalapos/cafe-data";
import { useDb, useData } from "../../db/provider";
import { session } from "../../staff/session";
import { ROLE_NAMES } from "../../staff/StaffPicker";
import { useScreenGate } from "../../staff/useApproval";
import { space } from "../../theme/tokens";
import { Banner, Button, Choice, Field, ListRow, Screen, Sheet } from "../../ui";

const ROLE_OPTIONS = CAFE_ROLES.map((r) => ({ value: r, label: ROLE_NAMES[r] }));

type Form =
  | { mode: "add"; name: string; role: CafeRole; pin: string; pinAgain: string }
  | { mode: "edit"; staff: Staff; name: string; role: CafeRole }
  | { mode: "pin"; staff: Staff; pin: string; pinAgain: string };

const message = (e: unknown) => (e instanceof StaffError ? e.message : "This could not be saved. Try again.");

/** Owner only: add people with a role and PIN, rename, change role, reset a PIN, deactivate or bring back. */
function StaffScreen() {
  const db = useDb();
  const staff = useData((d) => listStaff(d, { includeInactive: true }));
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const open = (f: Form) => { setError(null); setForm(f); };
  const close = () => { setForm(null); setError(null); };

  /** Keeps the signed-in person's copy current; signs them out if they are no longer active. */
  function refreshSession(updated: Staff) {
    const current = session.get().staff;
    if (current?.id !== updated.id) return;
    if (updated.active) session.signIn(updated);
    else { session.signOut(); router.replace("/lock"); }
  }

  async function save() {
    if (!form) return;
    if (form.mode !== "edit") {
      if (!isValidPin(form.pin)) return setError("Use 4 to 6 digits for the PIN");
      if (form.pin !== form.pinAgain) return setError("The two PINs are different");
    }
    setSaving(true);
    try {
      const now = Date.now();
      if (form.mode === "add") addStaff(db, { name: form.name, role: form.role, pinHash: await hashPin(form.pin) }, now);
      else if (form.mode === "edit") refreshSession(updateStaff(db, form.staff.id, { name: form.name, role: form.role }, now));
      else setStaffPinHash(db, form.staff.id, await hashPin(form.pin), now);
      close();
    } catch (e) {
      setError(message(e));
    } finally {
      setSaving(false);
    }
  }

  function setActive(s: Staff, active: boolean) {
    const go = () => {
      try { refreshSession(updateStaff(db, s.id, { active }, Date.now())); close(); } catch (e) { setError(message(e)); }
    };
    if (active) return go();
    Alert.alert(`Deactivate ${s.name}?`, "They can no longer sign in. Their old bills keep their name.", [
      { text: "Cancel", style: "cancel" },
      { text: "Deactivate", style: "destructive", onPress: go },
    ]);
  }

  const pinFields = form && form.mode !== "edit" ? (
    <>
      <Field label="PIN" help="4 to 6 digits" value={form.pin} onChangeText={(pin) => setForm({ ...form, pin })}
        keyboardType="number-pad" secureTextEntry maxLength={6} />
      <Field label="PIN again" value={form.pinAgain} onChangeText={(pinAgain) => setForm({ ...form, pinAgain })}
        keyboardType="number-pad" secureTextEntry maxLength={6} />
    </>
  ) : null;

  return (
    <Screen title="Staff" edges={["top", "bottom"]}
      actions={<Button label="Add person" icon="plus" onPress={() => open({ mode: "add", name: "", role: "cashier", pin: "", pinAgain: "" })} />}>
      {staff.map((s) => (
        <ListRow key={s.id} title={s.name} subtitle={`${ROLE_NAMES[s.role]}${s.active ? "" : " · deactivated"}`}
          onPress={() => open({ mode: "edit", staff: s, name: s.name, role: s.role })} />
      ))}
      <Sheet visible={form !== null} onClose={close}
        title={form?.mode === "add" ? "Add a person" : form?.mode === "pin" ? `New PIN for ${form.staff.name}` : form?.mode === "edit" ? form.staff.name : ""}
        footer={<Button label="Save" size="lg" busy={saving} onPress={() => void save()} />}>
        {form && form.mode !== "pin" ? (
          <>
            <Field label="Name" value={form.name} onChangeText={(name) => setForm({ ...form, name })} autoCapitalize="words" maxLength={30} />
            <Choice label="Role" options={ROLE_OPTIONS} value={form.role} onChange={(role) => setForm({ ...form, role })} />
          </>
        ) : null}
        {pinFields}
        {error ? <Banner tone="error" text={error} /> : null}
        {form?.mode === "edit" ? (
          <View style={styles.row}>
            <Button label="Reset PIN" variant="secondary" style={styles.grow}
              onPress={() => open({ mode: "pin", staff: form.staff, pin: "", pinAgain: "" })} />
            {form.staff.active
              ? <Button label="Deactivate" variant="danger" style={styles.grow} onPress={() => setActive(form.staff, false)} />
              : <Button label="Bring back" variant="secondary" style={styles.grow} onPress={() => setActive(form.staff, true)} />}
          </View>
        ) : null}
      </Sheet>
    </Screen>
  );
}

/** Only the owner manages staff; asked once on entry. */
export default function StaffTab() {
  const { allowed, sheet } = useScreenGate("staff.manage", "Manage staff");
  return <>{allowed ? <StaffScreen /> : <Screen title="Staff"><></></Screen>}{sheet}</>;
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: space.sm },
  grow: { flex: 1 },
});
