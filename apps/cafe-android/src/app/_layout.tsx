import "../polyfills";
import { DefaultTheme, Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { DbProvider } from "../db/provider";
import { color } from "../theme/tokens";

const theme = {
  ...DefaultTheme,
  colors: { ...DefaultTheme.colors, primary: color.primaryInk, background: color.background, card: color.surface, text: color.onSurface, border: color.outlineVariant },
};

export default function RootLayout() {
  return (
    <ThemeProvider value={theme}>
      <StatusBar style="dark" />
      <DbProvider>
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.background } }}>
          <Stack.Screen name="payment" options={{ presentation: "modal" }} />
        </Stack>
      </DbProvider>
    </ThemeProvider>
  );
}
