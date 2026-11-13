import { useState } from "react";
import { Text } from "react-native";
import { holdCart } from "@masalapos/cafe-data";
import { uuidv7 } from "@masalapos/domain/id";
import { cart } from "../cart/cart";
import { useDb } from "../db/provider";
import { session } from "../staff/session";
import { color, type } from "../theme/tokens";
import { Button, Field, Sheet } from "../ui";

/** Saves the cart to finish later, with an optional note, and clears the screen for the next customer. */
export function HoldSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const db = useDb();
  const [note, setNote] = useState("");
  function hold() {
    holdCart(db, { id: uuidv7(), cart: cart.toHeld(), note, staffId: session.get().staff?.id ?? null, now: Date.now() });
    cart.clear();
    setNote("");
    onClose();
  }
  return (
    <Sheet visible={visible} title="Hold this order" onClose={onClose} footer={<Button label="Hold" size="lg" onPress={hold} />}>
      <Text style={[type.body, { color: color.onSurfaceMuted }]}>Prices are worked out again when you open it.</Text>
      <Field label="Note (optional)" value={note} onChangeText={setNote} maxLength={40} placeholder="Blue shirt, 2 coffees" />
    </Sheet>
  );
}
