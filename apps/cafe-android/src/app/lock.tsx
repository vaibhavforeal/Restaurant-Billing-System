import { useState } from "react";
import { StyleSheet, Text } from "react-native";
import { Redirect, router } from "expo-router";
import { getCafe, listStaff, type Staff } from "@masalapos/cafe-data";
import { useData } from "../db/provider";
import { PinPad } from "../staff/PinPad";
import { StaffPicker } from "../staff/StaffPicker";
import { session } from "../staff/session";
import { color, type } from "../theme/tokens";
import { Screen } from "../ui";

/** Who is using the till: pick a name, enter that person's PIN. Shown at start, after the idle time and on Switch staff. */
export default function LockScreen() {
  const cafeName = useData((db) => getCafe(db)?.name ?? null);
  const staff = useData((db) => listStaff(db));
  const [picked, setPicked] = useState<Staff | null>(null);

  if (cafeName === null) return <Redirect href="/first-run" />;

  function signIn(s: Staff) {
    session.signIn(s);
    router.replace("/bill");
  }

  return (
    <Screen title={cafeName} edges={["top", "bottom"]}>
      {picked ? (
        <PinPad staff={picked} onSuccess={signIn} onBack={() => setPicked(null)} />
      ) : (
        <>
          <Text style={[type.body, styles.lead]}>Who is at the counter?</Text>
          <StaffPicker staff={staff} onPick={setPicked} />
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  lead: { color: color.onSurfaceMuted },
});
