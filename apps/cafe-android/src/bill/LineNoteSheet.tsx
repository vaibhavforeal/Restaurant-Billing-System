import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { cart } from "../cart/cart";
import type { CartEntry } from "../cart/cart-store";
import { color, radius, space, touch, type } from "../theme/tokens";
import { Button, Field, Sheet } from "../ui";

const QUICK = ["Less sugar", "No onion", "Extra hot"];

/** A note on one cart line for the kitchen slip. It does not print on the receipt. Open with a key per line. */
export function LineNoteSheet({ line, onClose }: { line: CartEntry | null; onClose: () => void }) {
  const [text, setText] = useState(line?.note ?? "");
  if (!line) return null;
  const save = (note: string | null) => { cart.setLineNote(line.key, note); onClose(); };
  return (
    <Sheet visible title={`Note for ${line.name}`} onClose={onClose}
      footer={<>
        <Button label="Save note" size="lg" onPress={() => save(text)} />
        {line.note ? <Button label="Remove note" variant="danger" onPress={() => save(null)} /> : null}
      </>}>
      <View style={styles.chips}>
        {QUICK.map((q) => (
          <Pressable key={q} accessibilityRole="button" onPress={() => setText(q)} style={styles.chip}>
            <Text style={[type.label, { color: color.onSurface }]}>{q}</Text>
          </Pressable>
        ))}
      </View>
      <Field label="Note for the kitchen" value={text} onChangeText={setText} maxLength={60} autoFocus placeholder="Less sugar" />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  chip: { minHeight: touch.min, justifyContent: "center", paddingHorizontal: space.md, borderRadius: radius.pill,
    backgroundColor: color.surfaceVariant },
});
