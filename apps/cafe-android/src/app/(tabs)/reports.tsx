import { Text } from "react-native";
import { Screen } from "../../ui";
import { color, type } from "../../theme/tokens";

export default function ReportsScreen() {
  return (
    <Screen title="Reports">
      <Text style={[type.body, { color: color.onSurfaceMuted }]}>Coming in this phase.</Text>
    </Screen>
  );
}
