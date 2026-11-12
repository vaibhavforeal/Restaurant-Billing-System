import { useState } from "react";
import { StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";
import { color, radius, space, touch, type } from "../theme/tokens";

/** A labelled text field with help or error text underneath. */
export function Field({ label, error, help, ...input }: TextInputProps & { label: string; error?: string | null; help?: string | null }) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={styles.wrap}>
      <Text style={[type.label, styles.label]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={color.disabled}
        {...input}
        onFocus={(e) => { setFocused(true); input.onFocus?.(e); }}
        onBlur={(e) => { setFocused(false); input.onBlur?.(e); }}
        style={[type.body, styles.input, focused && styles.focused, error ? styles.invalid : null, input.style]}
      />
      {error ? <Text style={[type.small, { color: color.error }]} accessibilityLiveRegion="polite">{error}</Text>
        : help ? <Text style={[type.small, { color: color.onSurfaceMuted }]}>{help}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.xxs },
  label: { color: color.onSurface },
  input: { minHeight: touch.min, borderWidth: 1, borderColor: color.outline, borderRadius: radius.sm, paddingHorizontal: space.sm,
    color: color.onSurface, backgroundColor: color.surface },
  focused: { borderColor: color.primary, borderWidth: 2 },
  invalid: { borderColor: color.error, borderWidth: 2 },
});
