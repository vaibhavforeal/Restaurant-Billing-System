import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { DeviceMe } from "@masalapos/domain";
import { apiFetch } from "./api";
import { gateDecision, homeForKind } from "./join-code";
import { isUnreachable } from "./offline-cache";
import { JoinScreen } from "./screens/JoinScreen";
import { AuthLayout } from "./screens/AuthLayout";
import { StartupScreen } from "./StartupScreen";

type Gate = { show: "checking" } | { show: "app" } | { show: "join"; me: DeviceMe } | { show: "error" };

/**
 * Stands in front of the POS, the kitchen display and the captain app: a browser that is not one of the restaurant's
 * devices gets the join screen instead. The hub decides who has joined; this asks it again whenever devices change,
 * so a device that is removed while in use lands back here.
 */
export function DeviceGate({ children }: { children: ReactNode }) {
  const [gate, setGate] = useState<Gate>({ show: "checking" });
  const sequence = useRef(0);
  const check = useCallback(async () => {
    const request = ++sequence.current;
    /** The answer, or "unreachable" when the hub could not be reached at all; any other failure is thrown. */
    const ask = async <T,>(path: string): Promise<T | "unreachable"> => {
      try { return await apiFetch<T>(path); }
      catch (error) { if (isUnreachable(error)) return "unreachable"; throw error; }
    };
    try {
      const [me, setup] = await Promise.all([ask<DeviceMe>("/api/devices/me"), ask<{ needsSetup: boolean }>("/api/needs-setup")]);
      if (request !== sequence.current) return;
      const decision = gateDecision(me, setup === "unreachable" ? setup : setup.needsSetup, window.location.pathname);
      if ("redirect" in decision) window.location.replace(decision.redirect); else setGate(decision);
    } catch {
      if (request === sequence.current) setGate((current) => current.show === "app" ? current : { show: "error" });
    }
  }, []);
  useEffect(() => {
    void check();
    const changed = () => { void check(); };
    window.addEventListener("masalapos:license-changed", changed);
    return () => { sequence.current++; window.removeEventListener("masalapos:license-changed", changed); };
  }, [check]);

  if (gate.show === "checking") return <StartupScreen />;
  if (gate.show === "error") return <AuthLayout><div className="auth-form">
    <p role="alert">Cannot reach the main POS. Check the restaurant network and try again.</p>
    <button type="button" className="primary" onClick={() => { setGate({ show: "checking" }); void check(); }}>Retry</button>
  </div></AuthLayout>;
  if (gate.show === "join") return <JoinScreen me={gate.me} onJoined={(kind) => window.location.replace(homeForKind(kind))} />;
  return <>{children}</>;
}
