import { useWindowDimensions } from "react-native";
import { TABLET_MIN_WIDTH } from "../theme/tokens";

/** Phone or tablet, from the window width; a widened window or a rotated tablet switches live. */
export function useLayout(): { tablet: boolean; width: number } {
  const { width } = useWindowDimensions();
  return { tablet: width >= TABLET_MIN_WIDTH, width };
}
