import { Text, type StyleProp, type TextStyle } from "react-native";
import { formatRupees } from "../money";
import { color, figures, type } from "../theme/tokens";

/** An amount in rupees with tabular figures, so amounts in a column line up. */
export function Money({ paise, size = "body", tone = color.onSurface, style }: {
  paise: number; size?: keyof typeof type; tone?: string; style?: StyleProp<TextStyle>;
}) {
  return <Text style={[type[size], figures, { color: tone }, style]}>{formatRupees(paise)}</Text>;
}
