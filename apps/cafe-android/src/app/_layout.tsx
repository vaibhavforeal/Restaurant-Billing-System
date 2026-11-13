import "../polyfills";
import { useEffect, type ReactNode } from "react";
import { AppState, View } from "react-native";
import { DefaultTheme, Stack, ThemeProvider, router, type ErrorBoundaryProps } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { getCounterSettings } from "@masalapos/cafe-data";
import { DbProvider, useDb } from "../db/provider";
import { ErrorScreen } from "../errors/ErrorScreen";
import { session } from "../staff/session";
import { color } from "../theme/tokens";

const theme = {
  ...DefaultTheme,
  colors: { ...DefaultTheme.colors, primary: color.primaryInk, background: color.background, card: color.surface, text: color.onSurface, border: color.outlineVariant },
};

/** A screen that throws shows what went wrong, records it, and offers Share error and Try again. */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return <ErrorScreen error={error} retry={() => void retry()} />;
}

/**
 * Every touch restarts the idle time. After the cafe's lock time without a touch the person is signed out and the
 * lock screen shows: checked when the app comes back to the foreground, and every 30 seconds while it stays open, so a
 * till left on the counter locks too.
 */
function IdleLock({ children }: { children: ReactNode }) {
  const db = useDb();
  useEffect(() => {
    const check = () => {
      if (!session.shouldLock(getCounterSettings(db).lockAfterMinutes)) return;
      session.signOut();
      router.replace("/lock");
    };
    const sub = AppState.addEventListener("change", (state) => { if (state === "active") check(); });
    const timer = setInterval(() => { if (AppState.currentState === "active") check(); }, 30_000);
    return () => { sub.remove(); clearInterval(timer); };
  }, [db]);
  return <View style={{ flex: 1 }} onTouchStart={() => session.touch()}>{children}</View>;
}

export default function RootLayout() {
  return (
    <ThemeProvider value={theme}>
      <StatusBar style="dark" />
      <DbProvider>
        <IdleLock>
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.background } }}>
            <Stack.Screen name="payment" options={{ presentation: "modal" }} />
          </Stack>
        </IdleLock>
      </DbProvider>
    </ThemeProvider>
  );
}
