import { useEffect, useRef, useState } from "react";
import type { GuestMenu as GuestMenuData, GuestReceipt, GuestSubmission } from "@forkflow/domain";
import { uuid } from "../uuid";
import { GuestServices } from "./GuestServices";
import "../guest-menu.css";

type MenuProduct = GuestMenuData["products"][number];
type CartItem = GuestSubmission["items"][number] & { key: string; name: string; pricePaise: number };
type SavedRequest = { submission: GuestSubmission; receipt: GuestReceipt | null };
type SavedState = { version: 1; cart: CartItem[]; menuVersion: string | null; reviewRequired: boolean; request: SavedRequest | null; history: SavedRequest[]; historyTruncated: boolean };
const money = (paise: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(paise / 100);
const emptyState = (): SavedState => ({ version: 1, cart: [], menuVersion: null, reviewRequired: false, request: null, history: [], historyTruncated: false });
const PREPARATION_LABELS = { queued: "Queued", preparing: "Preparing", ready: "Ready", cancelled: "Cancelled", with_staff: "With staff" };
function waitingForPreparation(receipt: GuestReceipt | null) {
  return receipt?.status === "accepted" && (!receipt.preparation || ["queued", "preparing", "with_staff"].includes(receipt.preparation.state));
}
function retainEarlierRequests(requests: SavedRequest[]) {
  const active = requests.filter((request) => waitingForPreparation(request.receipt));
  const remaining = Math.max(0, 20 - active.length);
  const finished = remaining > 0 ? requests.filter((request) => !waitingForPreparation(request.receipt)).slice(-remaining) : [];
  const retained = new Set([...active, ...finished]);
  return requests.filter((request) => retained.has(request));
}
const storageKey = (token: string) => `forkflow.guest.v1.${token}`;
const hexToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
function localPhoto(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value, window.location.href);
    return url.origin === window.location.origin && ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

function validRequest(request: SavedRequest) {
  return !!request?.submission && typeof request.submission.clientRef === "string" &&
    /^[a-f0-9]{64}$/.test(request.submission.receiptToken) && Array.isArray(request.submission.items) &&
    (!request.receipt || (typeof request.receipt.id === "string" && Array.isArray(request.receipt.items) &&
      ["pending", "accepted", "rejected", "expired"].includes(request.receipt.status)));
}

function readSaved(token: string): SavedState {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(token)) ?? "null") as SavedState | null;
    if (!value || value.version !== 1 || !Array.isArray(value.cart) || value.cart.length > 30 ||
      value.cart.some((item) => typeof item.key !== "string" || typeof item.productId !== "string" ||
        (item.variantId !== null && typeof item.variantId !== "string") || typeof item.name !== "string" ||
        !Number.isSafeInteger(item.pricePaise) || !Number.isInteger(item.qty) || item.qty < 1 || item.qty > 20 || typeof item.note !== "string")) return emptyState();
    if (value.request && !validRequest(value.request)) return emptyState();
    const history = Array.isArray(value.history) ? value.history.filter((request) => validRequest(request) && request.receipt?.status === "accepted") : [];
    const retained = retainEarlierRequests(history);
    return { ...value, reviewRequired: !!value.reviewRequired, request: value.request ?? null, history: retained, historyTruncated: !!value.historyTruncated || retained.length < history.length };
  } catch { return emptyState(); }
}

class GuestApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}

async function guestFetch<T>(path: string, init: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(path, { ...init, credentials: "omit", cache: "no-store", signal: controller.signal });
    const payload = await response.json() as T & { error?: string; message?: string; code?: string };
    if (!response.ok) throw new GuestApiError(payload.message ?? payload.error ?? "The restaurant could not complete this request.", response.status, payload.code ?? payload.error ?? "");
    return payload;
  } finally { window.clearTimeout(timeout); }
}

function reconcileCart(cart: CartItem[], menu: GuestMenuData): CartItem[] {
  return cart.flatMap((item) => {
    const product = menu.products.find((candidate) => candidate.id === item.productId);
    if (!product || product.isSoldOut) return [];
    const variant = product.variants.find((candidate) => candidate.id === item.variantId);
    if ((item.variantId !== null && !variant) || (item.variantId === null && product.variants.length > 0)) return [];
    return [{ ...item, name: variant ? `${product.name} (${variant.name})` : product.name, pricePaise: variant?.pricePaise ?? product.pricePaise }];
  });
}

export function GuestMenu({ token }: { token: string }) {
  return <GuestMenuContent key={token} token={token} />;
}

function GuestMenuContent({ token }: { token: string }) {
  const [saved, setSaved] = useState(() => readSaved(token));
  const savedRef = useRef(saved);
  const [menu, setMenu] = useState<GuestMenuData | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [vegOnly, setVegOnly] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [statusError, setStatusError] = useState("");
  const [historyErrors, setHistoryErrors] = useState<Record<string, string>>({});
  const [storageWarning, setStorageWarning] = useState(false);
  const [sending, setSending] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const sendingRef = useRef(false);
  const mounted = useRef(true);
  const menuLoadId = useRef(0);
  const cartRef = useRef<HTMLElement>(null);

  function save(next: SavedState) {
    savedRef.current = next;
    setSaved(next);
    try { localStorage.setItem(storageKey(token), JSON.stringify(next)); setStorageWarning(false); }
    catch { setStorageWarning(true); }
  }

  async function loadMenu(explicitReview = false) {
    const loadId = ++menuLoadId.current;
    setLoading(true); setError("");
    try {
      if (!token) throw new Error("This menu link is incomplete. Please scan the QR code on your table again.");
      const nextMenu = await guestFetch<GuestMenuData>("/api/guest/menu", { headers: { "x-qr-token": token } });
      if (!mounted.current || loadId !== menuLoadId.current) return;
      setMenu(nextMenu);
      const previous = savedRef.current;
      if (!previous.request) {
        const changed = previous.menuVersion !== null && previous.menuVersion !== nextMenu.menuVersion;
        const nextCart = reconcileCart(previous.cart, nextMenu);
        save({ ...previous, cart: nextCart, menuVersion: nextMenu.menuVersion, reviewRequired: previous.reviewRequired || ((changed || explicitReview) && nextCart.length > 0) });
        if ((changed || explicitReview) && previous.cart.length) {
          const removed = previous.cart.length - nextCart.length;
          setNotice(`The menu has been updated. ${removed ? `${removed} unavailable item${removed === 1 ? " was" : "s were"} removed. ` : ""}Please review your items and the current prices before submitting.`);
        }
      }
      setNeedsRefresh(false);
    } catch (cause) {
      if (mounted.current && loadId === menuLoadId.current) setError(cause instanceof GuestApiError && [401, 403, 404, 410].includes(cause.status)
        ? "This table menu is unavailable. Please ask a member of staff for help."
        : cause instanceof Error && !token ? cause.message : "Could not reach the restaurant. Check your connection and try again.");
    } finally { if (mounted.current && loadId === menuLoadId.current) setLoading(false); }
  }

  useEffect(() => {
    mounted.current = true;
    void loadMenu();
    return () => { mounted.current = false; };
  }, [token]);

  const receipt = saved.request?.receipt;
  useEffect(() => {
    if (!receipt || !["pending", "accepted"].includes(receipt.status)) return;
    let active = true;
    let timer: number | undefined;
    const receiptId = receipt.id;
    async function poll() {
      const request = savedRef.current.request;
      if (!request || request.receipt?.id !== receiptId) return;
      try {
        const { request: next } = await guestFetch<{ request: GuestReceipt }>(`/api/guest/requests/${encodeURIComponent(receiptId)}`, {
          headers: { "x-guest-receipt": request.submission.receiptToken },
        });
        if (!active) return;
        const current = savedRef.current;
        if (current.request?.receipt?.id === receiptId) save({ ...current, request: { ...current.request, receipt: next } });
        setStatusError("");
        if (["pending", "accepted"].includes(next.status)) timer = window.setTimeout(() => void poll(), 5000);
      } catch {
        if (!active) return;
        setStatusError(savedRef.current.request?.receipt?.status === "accepted"
          ? "Preparation updates could not be refreshed. The last confirmed status is shown. Please ask our team for an update."
          : "Status could not be refreshed. Your request is still awaiting restaurant confirmation. Please check with staff before ordering again.");
        timer = window.setTimeout(() => void poll(), 5000);
      }
    }
    void poll();
    return () => { active = false; if (timer !== undefined) window.clearTimeout(timer); };
  }, [receipt?.id, receipt?.status, token]);

  const historyPollKey = saved.history.filter((request) => waitingForPreparation(request.receipt)).map((request) => request.receipt!.id).join(":");
  useEffect(() => {
    let active = true;
    const timers = new Set<number>();
    for (const receiptId of historyPollKey.split(":").filter(Boolean)) {
      function later() {
        const timer = window.setTimeout(() => { timers.delete(timer); void poll(); }, 5000);
        timers.add(timer);
      }
      async function poll() {
        const request = savedRef.current.history.find((item) => item.receipt?.id === receiptId);
        if (!request || !waitingForPreparation(request.receipt)) return;
        try {
          const { request: next } = await guestFetch<{ request: GuestReceipt }>(`/api/guest/requests/${encodeURIComponent(receiptId)}`, {
            headers: { "x-guest-receipt": request.submission.receiptToken },
          });
          if (!active) return;
          const latest = savedRef.current;
          save({ ...latest, history: latest.history.map((item) => item.receipt?.id === receiptId ? { ...item, receipt: next } : item) });
          setHistoryErrors((values) => ({ ...values, [receiptId]: "" }));
          if (waitingForPreparation(next)) later();
        } catch {
          if (!active) return;
          setHistoryErrors((values) => ({ ...values, [receiptId]: "Could not refresh this preparation update. Please check with our team." }));
          later();
        }
      }
      void poll();
    }
    return () => { active = false; timers.forEach((timer) => window.clearTimeout(timer)); };
  }, [historyPollKey, token]);

  function add(product: MenuProduct, variantId: string | null) {
    if (!menu?.orderingAvailable || product.isSoldOut || savedRef.current.request || sendingRef.current || needsRefresh) return;
    const current = savedRef.current;
    const variant = product.variants.find((candidate) => candidate.id === variantId);
    if (variantId && !variant) return;
    const existing = current.cart.find((item) => item.productId === product.id && item.variantId === variantId && !item.note);
    if (existing && existing.qty >= 20) { setError("You can add up to 20 of an item. Please ask staff for larger orders."); return; }
    if (!existing && current.cart.length >= 30) { setError("A request can contain up to 30 menu selections. Please ask staff for a larger order."); return; }
    const cart = existing ? current.cart.map((item) => item.key === existing.key ? { ...item, qty: item.qty + 1 } : item)
      : [...current.cart, { key: uuid(), productId: product.id, variantId, qty: 1, note: "", name: variant ? `${product.name} (${variant.name})` : product.name, pricePaise: variant?.pricePaise ?? product.pricePaise }];
    save({ ...current, cart, menuVersion: menu.menuVersion });
    setError(""); setNotice(`Added ${product.name} to your request.`);
  }

  function editItem(key: string, patch: Partial<Pick<CartItem, "qty" | "note">>) {
    const current = savedRef.current;
    if (current.request || sendingRef.current) return;
    save({ ...current, cart: current.cart.map((item) => item.key === key ? { ...item, ...patch } : item).filter((item) => item.qty > 0) });
    setError("");
  }

  async function submit() {
    if (sendingRef.current) return;
    const previous = savedRef.current;
    const retry = previous.request !== null;
    if (previous.request?.receipt || (!retry && (!menu?.orderingAvailable || !previous.cart.length || previous.reviewRequired || needsRefresh))) return;
    if (!retry && previous.cart.some((item) => /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(item.note))) {
      setError("An instruction contains unsupported control characters. Please edit the item instructions and try again."); return;
    }
    const submission = previous.request?.submission ?? {
      clientRef: uuid(), receiptToken: hexToken(), menuVersion: menu!.menuVersion,
      items: previous.cart.map(({ productId, variantId, qty, note }) => ({ productId, variantId, qty, note: note.trim() })),
    };
    const frozen: SavedState = { ...previous, request: { submission, receipt: null } };
    // Store the immutable request before sending: a lost response or reload must reuse its identity.
    try {
      const encoded = JSON.stringify(frozen);
      localStorage.setItem(storageKey(token), encoded);
      if (localStorage.getItem(storageKey(token)) !== encoded) throw new Error("Storage is unavailable");
    } catch {
      setStorageWarning(true);
      setError("Your browser could not save this request safely. Enable website storage, or ask staff to take your order.");
      return;
    }
    sendingRef.current = true; setSending(true); save(frozen); setError(""); setNotice("");
    try {
      const { request: next } = await guestFetch<{ request: GuestReceipt }>("/api/guest/requests", {
        method: "POST", headers: { "Content-Type": "application/json", "x-qr-token": token }, body: JSON.stringify(submission),
      });
      if (!mounted.current) return;
      save({ ...frozen, cart: [], request: { submission, receipt: next } });
      setStatusError("");
    } catch (cause) {
      if (!mounted.current) return;
      const stale = cause instanceof GuestApiError && cause.status === 409 && /menu|stale/i.test(cause.code);
      if (stale) {
        save({ ...frozen, request: null, reviewRequired: true });
        setNeedsRefresh(true);
        setError("The menu changed before your request was submitted. Reload the menu, then review your items and prices.");
      } else if (!retry && cause instanceof GuestApiError && [400, 401, 403, 404, 410, 422, 429].includes(cause.status)) {
        save({ ...frozen, request: null });
        setError(cause.status === 429 ? "There are too many requests right now. Please wait a moment, or ask staff for help."
          : "The restaurant could not accept this request. Please refresh the menu or ask staff for help.");
      } else {
        setError("We could not confirm whether the restaurant received your request. Retry the same request below to check safely. Please do not place it again with staff without checking first.");
      }
    } finally { sendingRef.current = false; if (mounted.current) setSending(false); }
  }

  function startAnother() {
    const previous = savedRef.current;
    if (!previous.request?.receipt || previous.request.receipt.status === "pending") return;
    const history = previous.request.receipt.status === "accepted"
      ? [...previous.history.filter((item) => item.receipt?.id !== previous.request!.receipt!.id), previous.request] : previous.history;
    const preparingCount = history.filter((item) => waitingForPreparation(item.receipt)).length;
    if (preparingCount >= 20) {
      setError(`You have ${preparingCount} requests still awaiting preparation or attention from our team. Please check with staff before starting another request.`);
      return;
    }
    const retained = retainEarlierRequests(history);
    save({ ...emptyState(), menuVersion: menu?.menuVersion ?? null, history: retained, historyTruncated: previous.historyTruncated || retained.length < history.length });
    setStatusError(""); setError(""); setNotice("");
    void loadMenu();
  }

  const locked = !!saved.request || sending || needsRefresh || loading;
  const subtotal = saved.cart.reduce((sum, item) => sum + item.pricePaise * item.qty, 0);
  const count = saved.cart.reduce((sum, item) => sum + item.qty, 0);
  const visible = menu?.products.filter((product) => (category === "all" || product.categoryId === category) && (!vegOnly || product.isVeg) &&
    `${product.name} ${product.description} ${product.variants.map((variant) => variant.name).join(" ")}`.toLowerCase().includes(search.trim().toLowerCase())) ?? [];

  return <main className="guest-menu">
    <header className="guest-menu-header"><div className="guest-menu-header-inner">
      <span className="guest-menu-brand" aria-hidden="true">F</span>
      <div><p className="guest-menu-kicker">Welcome to your table</p><h1>{menu?.restaurantName ?? "Restaurant menu"}</h1></div>
      {menu && <span className="guest-menu-table">{menu.table.name}{menu.table.area && <small>{menu.table.area}</small>}</span>}
    </div></header>
    <div className="guest-menu-content">
      {!menu && loading && <div className="guest-menu-empty" role="status">Loading your table menu…</div>}
      {error && <div className="guest-menu-message guest-menu-error" role="alert"><p>{error}</p>
        {needsRefresh ? <button disabled={loading || sending} onClick={() => void loadMenu(true)}>{loading ? "Reloading…" : "Reload menu and review"}</button>
          : !saved.request && <button disabled={loading} onClick={() => void loadMenu()}>{loading ? "Refreshing…" : "Refresh menu"}</button>}
      </div>}
      {storageWarning && <p className="guest-menu-message" role="status">Browser storage is unavailable. Your selections may not survive a reload.</p>}
      {notice && <p className="guest-menu-announcement" role="status">{notice}</p>}
      <GuestServices token={token} available={menu?.orderingAvailable ?? false} />
      {saved.history.length > 0 && <EarlierRequests requests={saved.history} errors={historyErrors} truncated={saved.historyTruncated} />}
      {saved.request?.receipt && <ReceiptCard receipt={saved.request.receipt} error={statusError} onNew={startAnother} orderingAvailable={menu?.orderingAvailable ?? false} />}
      {saved.request && !saved.request.receipt && <section className="guest-menu-request" aria-label="Unconfirmed request">
        <p className="guest-menu-kicker">{sending ? "Sending your request" : "Confirmation needed"}</p>
        <h2>{sending ? "Contacting the restaurant…" : "Your request is not yet confirmed"}</h2>
        <p>{sending ? "Please keep this page open while we confirm receipt." : "Your selections are saved and locked. Retrying uses the same request and will not create a duplicate."}</p>
        <button className="guest-menu-primary" disabled={sending} onClick={() => void submit()}>{sending ? "Checking…" : "Retry the same request"}</button>
      </section>}
      {menu && <>
        <div className="guest-menu-intro"><div><p className="guest-menu-kicker">Fresh from our kitchen</p><h2>What would you like?</h2>
          <p>{menu.orderingAvailable ? "Choose your favourites. Our team will review your request before preparing your order." : "Take a look at our menu, then ask our team to place your order."}</p></div>
          <div className="guest-menu-intro-actions"><span className="guest-menu-mode">{menu.orderingAvailable ? "Order at your table" : "Browse our menu"}</span><button disabled={loading || sending} onClick={() => void loadMenu()}>{loading ? "Refreshing…" : "Refresh menu"}</button></div>
        </div>
        <div className={`guest-menu-layout${menu.orderingAvailable && !receipt ? "" : " guest-menu-browse-only"}`}>
          <section className="guest-menu-catalog" aria-label="Menu">
            <div className="guest-menu-search"><label htmlFor="guest-search">Find something delicious</label><input id="guest-search" type="search" placeholder="Search dishes or sizes" value={search} onChange={(event) => setSearch(event.target.value)} />
              <label className="guest-menu-veg-filter"><input type="checkbox" checked={vegOnly} onChange={(event) => setVegOnly(event.target.checked)} /> Vegetarian only</label></div>
            <div className="guest-menu-categories" aria-label="Menu categories"><button aria-pressed={category === "all"} onClick={() => setCategory("all")}>All dishes</button>
              {menu.categories.map((item) => <button key={item.id} aria-pressed={category === item.id} onClick={() => setCategory(item.id)}>{item.name}</button>)}
            </div>
            <div className="guest-menu-products">{visible.map((product) => <ProductCard key={`${menu.menuVersion}:${product.id}`} product={product} orderingAvailable={menu.orderingAvailable} locked={locked} onAdd={add} />)}</div>
            {!visible.length && <div className="guest-menu-empty"><h3>{menu.products.length ? "No dishes found" : "The menu is being prepared"}</h3><p>{menu.products.length ? "Try another search or category." : "Please ask our team about today's menu."}</p></div>}
          </section>
          {menu.orderingAvailable && !receipt && <aside className="guest-menu-cart" aria-label="Your request" ref={cartRef} id="guest-cart" tabIndex={-1}>
            <div className="guest-menu-cart-heading"><h2>Your request</h2><span>{count} item{count === 1 ? "" : "s"}</span></div>
            {!saved.cart.length ? <p className="guest-menu-cart-empty">Your table is ready. Add a dish to get started.</p> : <>
              <ul className="guest-menu-cart-items">{saved.cart.map((item) => <li key={item.key}>
                <div className="guest-menu-cart-item-heading"><h3>{item.name}</h3><strong>{money(item.pricePaise * item.qty)}</strong></div>
                <small>{money(item.pricePaise)} each</small>
                <div className="guest-menu-quantity"><button aria-label={`Decrease ${item.name}`} disabled={locked} onClick={() => editItem(item.key, { qty: item.qty - 1 })}>−</button><span aria-label={`Quantity for ${item.name}`}>{item.qty}</span><button aria-label={`Increase ${item.name}`} disabled={locked || item.qty >= 20} onClick={() => editItem(item.key, { qty: item.qty + 1 })}>+</button><button className="guest-menu-remove" disabled={locked} onClick={() => editItem(item.key, { qty: 0 })} aria-label={`Remove ${item.name}`}>Remove</button></div>
                <label className="guest-menu-item-note">Instructions for {item.name}<textarea rows={2} maxLength={200} placeholder="Optional: less spicy, no onions…" value={item.note} disabled={locked} onChange={(event) => editItem(item.key, { note: event.target.value })} /></label>
              </li>)}</ul>
              <div className="guest-menu-cart-total"><div><span>Menu subtotal</span><strong>{money(subtotal)}</strong></div><p>No tax is added to menu prices. Your final bill is prepared at the restaurant.</p></div>
              {saved.reviewRequired && !needsRefresh && <label className="guest-menu-review"><input type="checkbox" disabled={locked} checked={false} onChange={() => save({ ...savedRef.current, reviewRequired: false })} /> I have reviewed the updated items and prices.</label>}
              <div className="guest-menu-cart-actions"><button className="guest-menu-primary" disabled={locked || saved.reviewRequired || loading} onClick={() => void submit()}>{sending ? "Sending…" : "Submit to staff"}</button><p>Staff must accept your request first. Pay at the restaurant.</p></div>
            </>}
          </aside>}
        </div>
      </>}
      <footer className="guest-menu-footer">No tax is added to menu prices. For allergies or special requirements, please speak with our team.</footer>
    </div>
    {menu?.orderingAvailable && saved.cart.length > 0 && !receipt && <button className="guest-menu-cart-shortcut" onClick={() => { cartRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); cartRef.current?.focus({ preventScroll: true }); }}><span>View request · {count} item{count === 1 ? "" : "s"}</span><strong>{money(subtotal)}</strong></button>}
  </main>;
}

function ProductCard({ product, orderingAvailable, locked, onAdd }: { product: MenuProduct; orderingAvailable: boolean; locked: boolean; onAdd: (product: MenuProduct, variantId: string | null) => void }) {
  const [variantId, setVariantId] = useState(product.variants[0]?.id ?? null);
  const [failedPhoto, setFailedPhoto] = useState<string | null>(null);
  const variant = product.variants.find((item) => item.id === variantId);
  const photo = localPhoto(product.photoUrl);
  return <article className={`guest-menu-product${product.isSoldOut ? " guest-menu-product-soldout" : ""}`}>
    {photo && failedPhoto !== photo && <img className="guest-menu-product-photo" src={photo} alt={product.name} loading="lazy" decoding="async" onError={() => setFailedPhoto(photo)} />}
    <div className={`guest-menu-diet${product.isVeg ? "" : " guest-menu-nonveg"}`}><span aria-hidden="true">●</span>{product.isVeg ? "Vegetarian" : "Non-vegetarian"}</div>
    <h3>{product.name}</h3>
    {product.description && <p className="guest-menu-product-description">{product.description}</p>}
    {product.isSoldOut && <p className="guest-menu-soldout">Sold out</p>}
    {product.variants.length > 0 && <label className="guest-menu-variant">Choose an option<select value={variantId ?? ""} onChange={(event) => setVariantId(event.target.value)} aria-label={`Option for ${product.name}`}>{product.variants.map((item) => <option key={item.id} value={item.id}>{item.name} · {money(item.pricePaise)}</option>)}</select></label>}
    <div className="guest-menu-product-bottom"><strong>{money(variant?.pricePaise ?? product.pricePaise)}</strong>{orderingAvailable && <button disabled={locked || product.isSoldOut} onClick={() => onAdd(product, variantId)} aria-label={`Add ${product.name}${variant ? `, ${variant.name}` : ""}`}>Add <span aria-hidden="true">+</span></button>}</div>
  </article>;
}

function ReceiptCard({ receipt, error, onNew, orderingAvailable }: { receipt: GuestReceipt; error: string; onNew: () => void; orderingAvailable: boolean }) {
  const preparation = receipt.status === "accepted" ? receipt.preparation : null;
  const progress = preparation ? {
    queued: { title: "Your request has been accepted", detail: "Your items are with our team and waiting to be sent to the kitchen." },
    preparing: { title: "Your order is being prepared", detail: "The kitchen is working on your requested items." },
    ready: { title: "Your requested items are ready", detail: "The kitchen has marked your items ready. Our team will take care of serving them." },
    cancelled: { title: "Your requested items were cancelled", detail: "Please speak with our team about your order." },
    with_staff: { title: "Your items are with our team", detail: "Our team is taking care of these items. Please ask them for a serving update." },
  }[preparation.state] : null;
  const text = {
    pending: { title: "Awaiting staff acceptance", detail: "The restaurant has received your request. Our team will review it before it goes to the kitchen." },
    accepted: { title: "Your request has been accepted", detail: "Your items have been added to your table's order. Our team will send them to the kitchen." },
    rejected: { title: "Your request was not accepted", detail: "Please speak with our team before placing another request." },
    expired: { title: "This request has expired", detail: "It was not accepted in time. Please speak with our team before placing another request." },
  }[receipt.status];
  return <section className={`guest-menu-request guest-menu-request-${receipt.status}`} aria-label="Request status">
    <div role="status"><p className="guest-menu-kicker">{receipt.tableName} · Request {receipt.id.slice(-6).toUpperCase()}</p><h2>{progress?.title ?? text.title}</h2><p>{progress?.detail ?? text.detail}</p></div>
    {receipt.reason && <p className="guest-menu-reason">Message from staff: {receipt.reason}</p>}
    {error && <p className="guest-menu-message" role="status">{error}</p>}
    {preparation && <div className="guest-menu-preparation" aria-label="Preparation of your requested items">
      <ul>{preparation.items.map((item, index) => <li key={`${index}:${item.name}`}><span>{item.qty} × {item.name}</span><span className={`guest-menu-preparation-state guest-menu-preparation-${item.state}`}>{PREPARATION_LABELS[item.state]}</span></li>)}</ul>
      {preparation.hasChanges && <p className="guest-menu-small">Our team updated some items or quantities. Please check with staff for details and your final bill.</p>}
    </div>}
    <details><summary>View request · {money(receipt.subtotalPaise)}</summary><ul className="guest-menu-receipt-items">{receipt.items.map((item, index) => <li key={`${item.productId}:${item.variantId}:${index}`}><span><strong>{item.qty} × {item.name}</strong>{item.note && <small>{item.note}</small>}</span><span>{money(item.qty * item.pricePaise)}</span></li>)}</ul><p className="guest-menu-small">Menu subtotal · No tax is added to menu prices. Pay at the restaurant.</p></details>
    {receipt.status !== "pending" && orderingAvailable && <button onClick={onNew}>{receipt.status === "accepted" ? "Order more" : "Start a new request"}</button>}
  </section>;
}

function EarlierRequests({ requests, errors, truncated }: { requests: SavedRequest[]; errors: Record<string, string>; truncated: boolean }) {
  return <section className="guest-menu-earlier" aria-label="Your earlier order requests">
    <h2>Your earlier requests</h2>
    {requests.toReversed().map(({ receipt }) => receipt && <details key={receipt.id}>
      <summary><span>Request {receipt.id.slice(-6).toUpperCase()} <small>{new Date(receipt.createdAt).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}</small></span><span className={`guest-menu-preparation-state guest-menu-preparation-${receipt.preparation?.state ?? "queued"}`} role="status">{receipt.preparation ? PREPARATION_LABELS[receipt.preparation.state] : "Accepted · Updating"}</span></summary>
      {receipt.preparation ? <div className="guest-menu-preparation"><ul>{receipt.preparation.items.map((item, index) => <li key={`${index}:${item.name}`}><span>{item.qty} × {item.name}</span><span>{PREPARATION_LABELS[item.state]}</span></li>)}</ul>
        {receipt.preparation.hasChanges && <p className="guest-menu-small">Our team updated some items or quantities. Please check with staff about the changes.</p>}
      </div> : <p className="guest-menu-small">Your request was accepted. Checking preparation updates…</p>}
      {errors[receipt.id] && <p className="guest-menu-small guest-menu-history-error" role="status">{errors[receipt.id]}</p>}
      <p className="guest-menu-small">Original menu subtotal: {money(receipt.subtotalPaise)}. Your final bill is prepared at the restaurant.</p>
    </details>)}
    {truncated && <p className="guest-menu-small">Older finished requests are no longer shown in this browser. Ask our team about older orders.</p>}
  </section>;
}
