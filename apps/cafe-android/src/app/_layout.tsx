import "../polyfills";
import { DefaultTheme, Stack, ThemeProvider, type ErrorBoundaryProps } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { DbProvider } from "../db/provider";
import { ErrorScreen } from "../errors/ErrorScreen";
import { color } from "../theme/tokens";

const theme = {
  ...DefaultTheme,
  colors: { ...DefaultTheme.colors, primary: color.primaryInk, background: color.background, card: color.surface, text: color.onSurface, border: color.outlineVariant },
};

/** A screen that throws shows what went wrong, records it, and offers Share error and Try again. */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return <ErrorScreen error={error} retry={() => void retry()} />;
}

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
