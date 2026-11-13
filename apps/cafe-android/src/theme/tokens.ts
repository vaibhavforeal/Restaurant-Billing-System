/**
 * MasalaPOS Cafe design tokens. Material 3 role names; light theme only. Screens use roles, never raw values.
 * Contrast (WCAG, computed from the hex): onPrimary on primary 7.2:1, onPrimaryStrong on primaryStrong 5.2:1,
 * onSurface on surface 17.8:1, onSurfaceMuted on surface 8.5:1 and on surfaceVariant 7.5:1, outline on surface 4.0:1,
 * primaryInk on surface 5.2:1, error 6.5:1, success 5.1:1, the containers' on-colours 7.7:1 and above.
 */
export const color = {
  /** The MasalaPOS orange from the website. The one interaction colour: main buttons, the active tab, selection. */
  primary: "#F58A07",
  /** Text and icons on primary. Orange is never used for text on white; use primaryInk. */
  onPrimary: "#1C1714",
  /** Deep orange for white text, where a stronger fill reads better (the token number). */
  primaryStrong: "#C2410C",
  onPrimaryStrong: "#FFFFFF",
  /** Selected tiles and chips. */
  primaryContainer: "#FFE2B5",
  onPrimaryContainer: "#1C1714",
  /** Orange as text on white or cream (links, "from ₹x"). */
  primaryInk: "#C2410C",

  background: "#F8F7F5",
  surface: "#FFFFFF",
  surfaceVariant: "#F4F1ED",
  onSurface: "#1C1714",
  onSurfaceMuted: "#554B44",
  /** Text field and card borders. */
  outline: "#8A7D72",
  /** Dividers and hairlines; decorative, not a boundary a user must see. */
  outlineVariant: "#E2DCD5",
  /** Disabled text and icons; exempt from contrast rules. */
  disabled: "#A8A29E",
  scrim: "rgba(28, 23, 20, 0.45)",

  error: "#B3261E",
  onError: "#FFFFFF",
  errorContainer: "#FDE7E4",
  onErrorContainer: "#8C1D18",
  success: "#1B7F3B",
  onSuccess: "#FFFFFF",
  successContainer: "#E3F4E8",
  onSuccessContainer: "#14532D",
  warningContainer: "#FFF0D6",
  onWarningContainer: "#5A3A00",
} as const;

/** One spacing scale, in dp. */
export const space = { xxs: 4, xs: 8, sm: 12, md: 16, lg: 24, xl: 32, xxl: 48 } as const;

export const radius = { sm: 8, md: 12, lg: 20, pill: 999 } as const;

/** Every pressable is at least this tall and wide. */
export const touch = { min: 48, large: 56 } as const;

/** From this window width (dp) the app uses the tablet layout: a side rail and a cart panel on the right. */
export const TABLET_MIN_WIDTH = 840;

/** Type scale on the system face (Roboto). Money uses `figures` so columns of amounts line up. */
export const type = {
  display: { fontSize: 40, lineHeight: 48, fontWeight: "700" },
  token: { fontSize: 96, lineHeight: 104, fontWeight: "800" },
  headline: { fontSize: 28, lineHeight: 36, fontWeight: "700" },
  title: { fontSize: 20, lineHeight: 28, fontWeight: "600" },
  body: { fontSize: 16, lineHeight: 24, fontWeight: "400" },
  bodyStrong: { fontSize: 16, lineHeight: 24, fontWeight: "600" },
  small: { fontSize: 14, lineHeight: 20, fontWeight: "400" },
  label: { fontSize: 14, lineHeight: 20, fontWeight: "600", letterSpacing: 0.1 },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: "400" },
} as const;

export const figures = { fontVariant: ["tabular-nums"] } as const;

/** Raised surfaces: the cart sheet and dialogs. Everything else is flat with hairlines. */
export const elevation = {
  sheet: { elevation: 8, shadowColor: "#1C1714", shadowOpacity: 0.18, shadowRadius: 16, shadowOffset: { width: 0, height: -2 } },
} as const;
