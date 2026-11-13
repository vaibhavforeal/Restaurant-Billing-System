import "../polyfills";
import { useEffect, type ReactNode } from "react";
import { AppState, StyleSheet, View } from "react-native";
import { DefaultTheme, Stack, ThemeProvider, router, useSegments, type ErrorBoundaryProps } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { getCafe, getCounterSettings, hasActiveOwner } from "@masalapos/cafe-data";
import { DbProvider, useDb, useData } from "../db/provider";
import { ErrorScreen } from "../errors/ErrorScreen";
import { lockNow } from "../staff/lock-now";
import { session, useCurrentStaff } from "../staff/session";
import { guardRoute } from "../start-route";
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
      lockNow();
    };
    const sub = AppState.addEventListener("change", (state) => { if (state === "active") check(); });
    const timer = setInterval(() => { if (AppState.currentState === "active") check(); }, 30_000);
    return () => { sub.remove(); clearInterval(timer); };
  }, [db]);
  return <View style={{ flex: 1 }} onTouchStart={() => session.touch()}>{children}</View>;
}

/** Every screen outside first run, Set owner PIN and the lock screen needs a signed-in person, however it was reached. */
function RouteGuard({ children }: { children: ReactNode }) {
  const segments = useSegments();
  const hasCafe = useData((db) => getCafe(db) !== null);
  const hasOwner = useData(hasActiveOwner);
  const signedIn = useCurrentStaff() !== null;
  const to = guardRoute(segments[0], { hasCafe, hasOwner, signedIn });
  useEffect(() => { if (to) router.replace(to); }, [to]);
  // The navigator stays mounted; a cover hides the screen for the moment before the redirect lands.
  return <>{children}{to ? <View style={[StyleSheet.absoluteFill, { backgroundColor: color.background }]} /> : null}</>;
}

export default function RootLayout() {
  return (
    <ThemeProvider value={theme}>
      <StatusBar style="dark" />
      <DbProvider>
        <IdleLock>
          <RouteGuard>
            <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.background } }}>
              <Stack.Screen name="payment" options={{ presentation: "modal" }} />
            </Stack>
          </RouteGuard>
        </IdleLock>
      </DbProvider>
    </ThemeProvider>
  );
}
