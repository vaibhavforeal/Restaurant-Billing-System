import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { color, radius, space, touch, type } from "../theme/tokens";
import { Icon, type IconName } from "./Icon";

type Variant = "primary" | "secondary" | "danger" | "quiet";

const look: Record<Variant, { bg: string; fg: string; border: string }> = {
  primary: { bg: color.primary, fg: color.onPrimary, border: color.primary },
  secondary: { bg: color.surface, fg: color.onSurface, border: color.outline },
  danger: { bg: color.surface, fg: color.error, border: color.error },
  quiet: { bg: "transparent", fg: color.primaryInk, border: "transparent" },
};

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: Variant;
  size?: "md" | "lg";
  icon?: IconName;
  disabled?: boolean;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityHint?: string;
}

/** The app's one button. Primary is the single main action on a screen. */
export function Button({ label, onPress, variant = "primary", size = "md", icon, disabled = false, busy = false, style, accessibilityHint }: ButtonProps) {
  const l = look[variant];
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: off, busy }}
      {...(accessibilityHint ? { accessibilityHint } : {})}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        { minHeight: size === "lg" ? touch.large : touch.min, backgroundColor: off && variant === "primary" ? color.surfaceVariant : l.bg,
          borderColor: off ? color.outlineVariant : l.border },
        pressed && !off && styles.pressed,
        style,
      ]}
    >
      <View style={styles.row}>
        {busy ? <ActivityIndicator color={l.fg} /> : icon ? <Icon name={icon} size={20} tint={off ? color.disabled : l.fg} /> : null}
        <Text style={[size === "lg" ? type.title : type.label, { color: off ? color.disabled : l.fg }]} numberOfLines={1}>{label}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { minWidth: touch.min, borderRadius: radius.md, borderWidth: 1, paddingHorizontal: space.md, justifyContent: "center", alignItems: "center" },
  row: { flexDirection: "row", alignItems: "center", gap: space.xs },
  pressed: { opacity: 0.85, transform: [{ scale: 0.98 }] },
});
