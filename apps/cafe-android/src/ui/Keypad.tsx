import { Pressable, StyleSheet, Text, View } from "react-native";
import { color, radius, space, touch, type } from "../theme/tokens";
import { Icon } from "./Icon";
import type { KeypadKey } from "./keypad-input";

export type { KeypadKey };

const ROWS: KeypadKey[][] = [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"], [".", "0", "back"]];

/** A large number pad for amounts. Set `decimal={false}` for PINs. */
export function Keypad({ onKey, decimal = true }: { onKey: (key: KeypadKey) => void; decimal?: boolean }) {
  return (
    <View style={styles.pad}>
      {ROWS.map((row, r) => (
        <View key={r} style={styles.row}>
          {row.map((key) => key === "." && !decimal ? <View key={key} style={styles.key} /> : (
            <Pressable
              key={key}
              accessibilityRole="button"
              accessibilityLabel={key === "back" ? "Delete" : key === "." ? "Point" : key}
              onPress={() => onKey(key)}
              style={({ pressed }) => [styles.key, styles.face, pressed && styles.pressed]}
            >
              {key === "back" ? <Icon name="backspace" /> : <Text style={[type.headline, styles.text]}>{key}</Text>}
            </Pressable>
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  pad: { gap: space.xs },
  row: { flexDirection: "row", gap: space.xs },
  key: { flex: 1, minHeight: touch.large + space.xs },
  face: { borderRadius: radius.md, backgroundColor: color.surfaceVariant, alignItems: "center", justifyContent: "center" },
  pressed: { backgroundColor: color.primaryContainer },
  text: { color: color.onSurface },
});
