import { useEffect } from "react";
import { ScrollView, Share, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { color, radius, space, type } from "../theme/tokens";
import { Button } from "../ui";
import { recordError, singleErrorReport } from "./capture";
import { errorText } from "./report";

/** Shown instead of a screen that failed: what went wrong, Share error, and Try again. Bills already saved are safe. */
export function ErrorScreen({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => { recordError(error, "screen"); }, [error]);
  const { message, stack } = errorText(error);
  return (
    <SafeAreaView style={styles.fill}>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={[type.headline, { color: color.onSurface }]} accessibilityRole="header">Something went wrong</Text>
        <Text style={[type.body, { color: color.onSurfaceMuted }]}>
          Saved bills are safe. Share this error with MasalaPOS so it can be fixed, then try again.
        </Text>
        <View style={styles.box}>
          <Text style={[type.bodyStrong, { color: color.onErrorContainer }]} selectable>{message}</Text>
          {stack ? <Text style={[type.caption, { color: color.onErrorContainer }]} selectable numberOfLines={12}>{stack}</Text> : null}
        </View>
        <Button label="Share error" size="lg" onPress={() => void Share.share({ message: singleErrorReport(error, "screen") })} />
        <Button label="Try again" variant="secondary" size="lg" onPress={retry} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: color.background },
  body: { padding: space.lg, gap: space.md },
  box: { backgroundColor: color.errorContainer, borderRadius: radius.md, padding: space.md, gap: space.xs },
});
