import { uuid } from "./uuid";

/** The reference of one attempt at a request. Kept in a ref so a retry of the same form contents reuses it. */
export type RequestRef = { fingerprint: string; ref: string } | null;

/**
 * The clientRef for a request: the same one while the form contents are unchanged, so a retry after a lost reply
 * is recognised by the hub instead of posted twice. Call `slot.current = null` once the request succeeded.
 */
export function refFor(slot: { current: RequestRef }, body: unknown): string {
  const fingerprint = JSON.stringify(body);
  if (slot.current?.fingerprint !== fingerprint) slot.current = { fingerprint, ref: uuid() };
  return slot.current.ref;
}
