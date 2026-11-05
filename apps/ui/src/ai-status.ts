import { useEffect, useState } from "react";
import { apiFetch } from "./api";
import { connectWs } from "./ws";

export interface AiStatus { enabled: boolean; canAsk: boolean; canDescribe: boolean; canManage: boolean }

/** Whether the AI assistant is on and what this person may use; null while loading. Re-read when settings change or the window regains focus. */
export function useAiStatus(): AiStatus | null {
  const [status, setStatus] = useState<AiStatus | null>(null);
  useEffect(() => {
    let active = true;
    const load = () => { apiFetch<AiStatus>("/api/ai/status").then((s) => { if (active) setStatus(s); }).catch(() => { if (active) setStatus(null); }); };
    load();
    window.addEventListener("focus", load);
    window.addEventListener("masalapos:ai-settings", load);
    const dispose = connectWs({ onEvent: (event) => { if (event === "settings.changed") load(); }, onStatus: (up) => { if (up) load(); } });
    return () => { active = false; window.removeEventListener("focus", load); window.removeEventListener("masalapos:ai-settings", load); dispose(); };
  }, []);
  return status;
}
