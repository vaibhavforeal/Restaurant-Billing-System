import { StyleSheet, Text, View } from "react-native";
import { color, radius, space, type } from "../theme/tokens";
import { Button } from "./Button";
import { Icon } from "./Icon";

const tones = {
  info: { bg: color.surfaceVariant, fg: color.onSurface },
  warning: { bg: color.warningContainer, fg: color.onWarningContainer },
  error: { bg: color.errorContainer, fg: color.onErrorContainer },
  success: { bg: color.successContainer, fg: color.onSuccessContainer },
} as const;

/** A message in the flow of the screen, with an optional action such as Try again. */
export function Banner({ tone = "info", text, action }: { tone?: keyof typeof tones; text: string; action?: { label: string; onPress: () => void } }) {
  const t = tones[tone];
  return (
    <View style={[styles.box, { backgroundColor: t.bg }]} accessibilityRole={tone === "error" ? "alert" : "summary"}>
      {tone === "warning" || tone === "error" ? <Icon name="warning" size={20} tint={t.fg} /> : null}
      <Text style={[type.small, styles.text, { color: t.fg }]}>{text}</Text>
      {action ? <Button label={action.label} onPress={action.onPress} variant="secondary" /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.sm, borderRadius: radius.md },
  text: { flex: 1 },
});
