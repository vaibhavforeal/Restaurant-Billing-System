import { useEffect, useRef, useState } from "react";
import type { ServiceReceipt, ServiceSubmission } from "@forkflow/domain";
import { uuid } from "../uuid";
import "../guest-services.css";

type Kind = ServiceSubmission["kind"];
type SavedCall = { submission: ServiceSubmission; receipt: ServiceReceipt | null };
type Calls = { version: 1; waiter: SavedCall | null; bill: SavedCall | null };
const kinds: Kind[] = ["waiter", "bill"];
const blank = (): Calls => ({ version: 1, waiter: null, bill: null });
const keyFor = (token: string) => `forkflow.guest-services.v1.${token}`;

function readCalls(token: string): Calls {
  try {
    const value = JSON.parse(localStorage.getItem(keyFor(token)) ?? "null") as Calls | null;
    if (!value || value.version !== 1) return blank();
    const next = blank();
    for (const kind of kinds) {
      const call = value[kind];
      if (!call) continue;
      if (call.submission?.kind !== kind || typeof call.submission.clientRef !== "string" || !/^[a-f0-9]{64}$/.test(call.submission.receiptToken)) continue;
      if (call.receipt && (typeof call.receipt.id !== "string" || call.receipt.kind !== kind || !["pending", "resolved", "expired"].includes(call.receipt.status))) continue;
      next[kind] = call;
    }
    return next;
  } catch { return blank(); }
}

class ServiceError extends Error {
  constructor(readonly status: number) { super("The restaurant could not complete this request"); }
}

async function serviceFetch(path: string, init: RequestInit): Promise<ServiceReceipt> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(path, { ...init, credentials: "omit", cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new ServiceError(response.status);
    return (await response.json() as { request: ServiceReceipt }).request;
  } finally { window.clearTimeout(timer); }
}

export function GuestServices({ token, available }: { token: string; available: boolean }) {
  return <ServiceCalls key={token} token={token} available={available} />;
}

function ServiceCalls({ token, available }: { token: string; available: boolean }) {
  const [calls, setCalls] = useState(() => readCalls(token));
  const current = useRef(calls);
  const [sending, setSending] = useState<Kind[]>([]);
  const sendingRef = useRef(new Set<Kind>());
  const [errors, setErrors] = useState<Record<Kind, string>>({ waiter: "", bill: "" });
  const [storageWarning, setStorageWarning] = useState(false);
  const mounted = useRef(true);

  function save(next: Calls) {
    current.current = next; setCalls(next);
    try { localStorage.setItem(keyFor(token), JSON.stringify(next)); setStorageWarning(false); }
    catch { setStorageWarning(true); }
  }

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let active = true;
    const timers: number[] = [];
    for (const kind of kinds) {
      if (current.current[kind]?.receipt?.status !== "pending") continue;
      async function poll() {
        const call = current.current[kind];
        if (!call?.receipt || call.receipt.status !== "pending") return;
        try {
          const receipt = await serviceFetch(`/api/guest/service-requests/${encodeURIComponent(call.receipt.id)}`, { headers: { "x-guest-receipt": call.submission.receiptToken } });
          if (!active) return;
          const latest = current.current;
          if (latest[kind]?.submission.clientRef === call.submission.clientRef) {
            save({ ...latest, [kind]: { ...call, receipt } });
            setErrors((value) => ({ ...value, [kind]: "" }));
          }
          if (receipt.status === "pending") timers.push(window.setTimeout(() => void poll(), 5000));
        } catch {
          if (!active) return;
          setErrors((value) => ({ ...value, [kind]: "Could not refresh this request. Its last confirmed status is shown; please check with staff." }));
          timers.push(window.setTimeout(() => void poll(), 5000));
        }
      }
      void poll();
    }
    return () => { active = false; timers.forEach(window.clearTimeout); };
  }, [calls.waiter?.receipt?.id, calls.waiter?.receipt?.status, calls.bill?.receipt?.id, calls.bill?.receipt?.status, token]);

  async function request(kind: Kind) {
    if (sendingRef.current.has(kind)) return;
    const previous = current.current[kind];
    const retry = !!previous && !previous.receipt;
    if (previous?.receipt?.status === "pending" || (!retry && !available)) return;
    const submission: ServiceSubmission = retry ? previous.submission : {
      clientRef: uuid(), receiptToken: Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join(""), kind,
    };
    const next: Calls = { ...current.current, [kind]: { submission, receipt: null } };
    try {
      const encoded = JSON.stringify(next);
      localStorage.setItem(keyFor(token), encoded);
      if (localStorage.getItem(keyFor(token)) !== encoded) throw new Error("Storage unavailable");
    } catch {
      setStorageWarning(true);
      setErrors((value) => ({ ...value, [kind]: "Your browser could not save this request safely. Please enable website storage or ask staff directly." }));
      return;
    }
    sendingRef.current.add(kind); setSending([...sendingRef.current]); save(next);
    setErrors((value) => ({ ...value, [kind]: "" }));
    try {
      const receipt = await serviceFetch("/api/guest/service-requests", {
        method: "POST", headers: { "Content-Type": "application/json", "x-qr-token": token }, body: JSON.stringify(submission),
      });
      if (!mounted.current) return;
      save({ ...current.current, [kind]: { submission, receipt } });
    } catch (cause) {
      if (!mounted.current) return;
      if (!retry && cause instanceof ServiceError && [400, 401, 403, 404, 409, 410, 422, 429].includes(cause.status)) {
        save({ ...current.current, [kind]: null });
        setErrors((value) => ({ ...value, [kind]: cause.status === 409
          ? "Someone at this table already has this request awaiting staff. Please check with our team."
          : cause.status === 429 ? "Please wait a moment before trying again, or speak with our team."
            : "This request could not be sent. Please ask a member of staff for help." }));
      } else {
        setErrors((value) => ({ ...value, [kind]: "Receipt is not confirmed. Retry this same saved request to check safely." }));
      }
    } finally {
      sendingRef.current.delete(kind);
      if (mounted.current) setSending([...sendingRef.current]);
    }
  }

  if (!available && !calls.waiter && !calls.bill) return null;
  return <section className="guest-services" aria-label="Ask our team">
    <div className="guest-services-heading"><h2>Need a hand?</h2><p>Our team is here to help. Pay at the restaurant.</p></div>
    {storageWarning && <p className="guest-services-error" role="status">Browser storage is unavailable. Saved request updates may not survive a reload.</p>}
    <div className="guest-services-grid">{kinds.filter((kind) => available || calls[kind]).map((kind) => {
      const call = calls[kind], receipt = call?.receipt, busy = sending.includes(kind);
      const title = kind === "waiter" ? "Call waiter" : "Request bill";
      return <div className="guest-service" key={kind} aria-label={title}>
        <div><h3>{title}</h3><p>{kind === "waiter" ? "Ask a member of our team to visit your table." : "Ask our team to bring the bill to your table."}</p></div>
        {receipt && <p className={`guest-service-status guest-service-${receipt.status}`} role="status">{receipt.status === "pending" ? "Sent to staff · Awaiting attention" : receipt.status === "resolved" ? "Our team marked this request handled." : "This request expired without being marked handled. Please speak with staff."}</p>}
        {call && !receipt && <p className="guest-service-status" role="status">{busy ? "Contacting the restaurant…" : "Your request is saved; receipt is not yet confirmed."}</p>}
        {errors[kind] && <p className="guest-services-error" role="alert">{errors[kind]}</p>}
        {(available || (call && !receipt)) && <button disabled={busy || receipt?.status === "pending"} onClick={() => void request(kind)}>
          {busy ? "Sending…" : call && !receipt ? `Retry ${kind === "waiter" ? "waiter" : "bill"} request` : receipt?.status === "pending" ? "Awaiting staff" : receipt ? `${title} again` : title}
        </button>}
      </div>;
    })}</div>
  </section>;
}
