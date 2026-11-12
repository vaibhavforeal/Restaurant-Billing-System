import { Text } from "react-native";
import { Screen } from "../../ui";
import { color, type } from "../../theme/tokens";

export default function MenuScreen() {
  return (
    <Screen title="Menu">
      <Text style={[type.body, { color: color.onSurfaceMuted }]}>Coming in this phase.</Text>
    </Screen>
  );
}
