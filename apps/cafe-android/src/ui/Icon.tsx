import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { color } from "../theme/tokens";

/** Our own outline icons on a 24-unit grid, stroked in the current role colour. */
const PATHS = {
  bill: "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3",
  bills: "M4 5h16M4 10h16M4 15h10M4 20h7",
  reports: "M4 20V10M10 20V4M16 20v-7M21 20H3",
  menu: "M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11M9 8h6",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  back: "M15 5l-7 7 7 7",
  chevron: "M9 5l7 7-7 7",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM16 16l5 5",
  close: "M6 6l12 12M18 6L6 18",
  backspace: "M9 5h11v14H9l-6-7zM12 9l5 6M17 9l-5 6",
  printer: "M7 9V3h10v6M7 17H4v-7h16v7h-3M7 14h10v7H7z",
  check: "M5 12l5 5 9-10",
  up: "M6 15l6-6 6 6",
  down: "M6 9l6 6 6-6",
  warning: "M12 4l9 16H3zM12 10v4M12 17h.01",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 24, tint = color.onSurface, strokeWidth = 2 }: { name: IconName; size?: number; tint?: ColorValue; strokeWidth?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d={PATHS[name]} stroke={tint} strokeWidth={name === "more" ? 3.2 : strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
