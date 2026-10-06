import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch, session } from "./api";

const PIN_ERROR = "Admin PIN is incorrect";

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
  session.set("token-1");
});
afterEach(() => { session.onUnauthorized = null; vi.unstubAllGlobals(); });

/** The next fetch answers 401 with this error message. */
function answer401(error: string) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error }), { status: 401, headers: { "content-type": "application/json" } })));
}

describe("apiFetch and 401 answers", () => {
  it("keeps the session on a wrong approval PIN when the caller names that message", async () => {
    const signedOut = vi.fn();
    session.onUnauthorized = signedOut;
    answer401(PIN_ERROR);
    const err = await apiFetch("/api/bills/b1/void", { method: "POST", body: "{}" }, { keepSessionOnMessage: PIN_ERROR }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, message: PIN_ERROR });
    expect(session.token).toBe("token-1");
    expect(signedOut).not.toHaveBeenCalled();
  });

  it("still signs out on any other 401, with or without the option", async () => {
    const signedOut = vi.fn();
    session.onUnauthorized = signedOut;
    answer401("unauthorized");
    await expect(apiFetch("/api/bills/b1/void", { method: "POST", body: "{}" }, { keepSessionOnMessage: PIN_ERROR })).rejects.toMatchObject({ status: 401 });
    expect(session.token).toBeNull();
    expect(signedOut).toHaveBeenCalledTimes(1);

    session.set("token-2");
    answer401(PIN_ERROR);
    await expect(apiFetch("/api/bills/b1/void", { method: "POST", body: "{}" })).rejects.toMatchObject({ status: 401 });
    expect(session.token).toBeNull();
    expect(signedOut).toHaveBeenCalledTimes(2);
  });
});
