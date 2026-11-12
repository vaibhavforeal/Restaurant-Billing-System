import { Text } from "react-native";
import { Screen } from "../../ui";
import { color, type } from "../../theme/tokens";

export default function BillsScreen() {
  return (
    <Screen title="Bills">
      <Text style={[type.body, { color: color.onSurfaceMuted }]}>Coming in this phase.</Text>
    </Screen>
  );
}
