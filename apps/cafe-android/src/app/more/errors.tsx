import { useEffect } from "react";
import { Alert, Share, StyleSheet, Text, View } from "react-native";
import { clearErrors, dataChanged, listErrors, setLocalState } from "@masalapos/cafe-data";
import { useDb, useData } from "../../db/provider";
import { deviceOffset } from "../../dates";
import { appVersion, ERRORS_SEEN_KEY } from "../../errors/capture";
import { formatErrorReport } from "../../errors/report";
import { color, radius, space, type } from "../../theme/tokens";
import { Button, Screen } from "../../ui";

/** Errors recorded on this phone, to share with MasalaPOS. */
export default function ErrorLog() {
  const db = useDb();
  const errors = useData(listErrors);
  useEffect(() => { setLocalState(db, { [ERRORS_SEEN_KEY]: Date.now() }); dataChanged(); }, [db, errors.length]);
  const report = () => formatErrorReport(errors, { appVersion: appVersion(), tzOffsetMinutes: deviceOffset() });

  return (
    <Screen title="Error log" edges={["top", "bottom"]}>
      <Text style={[type.body, { color: color.onSurfaceMuted }]}>
        Problems the app met on this phone. Share them with MasalaPOS to get them fixed. Your bills are not included.
      </Text>
      <View style={styles.actions}>
        <Button label="Share" size="lg" disabled={!errors.length} onPress={() => void Share.share({ message: report() })} style={styles.grow} />
        <Button label="Clear" variant="danger" disabled={!errors.length}
          onPress={() => Alert.alert("Clear the error log?", "The recorded errors are deleted.", [
            { text: "Cancel", style: "cancel" }, { text: "Clear", style: "destructive", onPress: () => clearErrors(db) }])} />
      </View>
      {errors.length === 0 ? <Text style={[type.body, { color: color.onSurface }]}>No errors recorded.</Text> : null}
      {errors.map((e, i) => (
        <View key={`${e.at}-${i}`} style={styles.entry}>
          <Text style={[type.caption, { color: color.onSurfaceMuted }]}>
            {new Date(e.at + deviceOffset(e.at) * 60_000).toISOString().slice(0, 16).replace("T", " ")}{e.context ? ` · ${e.context}` : ""}
          </Text>
          <Text style={[type.bodyStrong, { color: color.onSurface }]} selectable>{e.message}</Text>
          {e.stack ? <Text style={[type.caption, { color: color.onSurfaceMuted }]} numberOfLines={4} selectable>{e.stack}</Text> : null}
        </View>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: "row", gap: space.sm },
  grow: { flex: 1 },
  entry: { backgroundColor: color.surface, borderRadius: radius.md, borderWidth: 1, borderColor: color.outlineVariant, padding: space.md, gap: space.xxs },
});
