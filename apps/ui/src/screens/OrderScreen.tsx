import { useEffect, useRef, useState } from "react";
import { priceForTier, PRICE_TIER_LABELS } from "@forkflow/domain/pricing";
import { ApiError, apiFetch, session, type User } from "../api";
import { paiseToRupees } from "../money";
import type { Category, Order, OrderItem, OrderTypeInfo, Product, TableInfo } from "../types";
import { connectWs } from "../ws";
import { uuid } from "../uuid";
import { OrderCustomer } from "./OrderCustomer";
import { BillingPanel } from "./BillingPanel";
import { mergeBlockedReason, mergeRoles } from "../table-transfer";
import { MergeOrderDialog, MoveTableDialog, orderLabel, type MergeChoice } from "./TableTransferDialogs";
import { Icon } from "../Icon";
import { zomatoLabel } from "../zomato-desk";
import { OverflowMenu, QtyStepper, TerminalClock } from "../PosControls";
import { WorkspaceDialog } from "../WorkspaceDialog";
import { savePreference, useShortcutLabels } from "../pos-shortcuts";
import { enqueueRequest, outcomeOrSaved, queuedRequests, subscribeQueue, type QueueRequest } from "../retry-queue";
import { isUnreachable, placeholderOrder, readCatalogCopy, readOrderCopy, saveCatalogCopy, saveOrderCopy, type CatalogCache } from "../offline-cache";
import { useNavigationGuard } from "../navigation-guard";
import { useIntegrations } from "../integrations";
import "../product-editor.css";
import "../order-screen.css";
import { userCan } from "../permissions";

// A status line to show on the next order screen: a merge switches screens, which would otherwise drop it.
let carriedStatus: { orderId: string; text: string; at: number } | null = null;
function carryStatus(orderId: string, text: string, overwrite: boolean) {
  if (overwrite || !carriedStatus || carriedStatus.orderId !== orderId || Date.now() - carriedStatus.at > 5000) carriedStatus = { orderId, text, at: Date.now() };
}
function carriedStatusFor(orderId: string): string {
  return carriedStatus && carriedStatus.orderId === orderId && Date.now() - carriedStatus.at < 5000 ? carriedStatus.text : "";
}

interface DraftItem {
  clientRef: string;
  productId: string;
  variantId: string | null;
  name: string;
  pricePaise: number;
  qty: number;
  note: string;
}

export function OrderScreen({ user, orderId, onBack, onOpenOrder, quickBilling = false, onNextTakeaway, onHold, captain = false }: { user: User; orderId: string; onBack: () => void; onOpenOrder: (orderId: string) => void; quickBilling?: boolean; onNextTakeaway?: () => void; onHold?: () => void; captain?: boolean }) {
  const crm = useIntegrations().isEnabled("crm");
  const { shortcut, shortcutProps } = useShortcutLabels();
  const draftKey = `forkflow.draft.${user.id}.${orderId}`;
  function readDraft(): DraftItem[] {
    try { return JSON.parse(localStorage.getItem(draftKey) ?? localStorage.getItem(`forkflow.draft.${orderId}`) ?? "[]"); } catch { return []; }
  }
  const [order, setOrder] = useState<Order | null>(null);
  const [captains, setCaptains] = useState<Array<{ id: string; name: string }>>([]);
  /** Active takeaway and delivery types; the picker shows only when the restaurant added its own. */
  const [takeawayTypes, setTakeawayTypes] = useState<OrderTypeInfo[]>([]);
  const [captainPickerOpen, setCaptainPickerOpen] = useState(false);
  const [captainError, setCaptainError] = useState("");
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedCat, setSelectedCat] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftItem[]>(readDraft);
  const [, refreshQueue] = useState(0);
  /** When the screen shows this device's saved copy because the hub cannot be reached: the time of that copy. */
  const [copyAt, setCopyAt] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const actionLock = useRef(false);
  const billingLock = useRef(false);
  const reloadRevision = useRef(0);
  const [billingBusy, setBillingBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [mobilePane, setMobilePane] = useState<"menu" | "cart">("menu");
  const cartItems = useRef<HTMLDivElement>(null);
  const menuSearch = useRef<HTMLInputElement>(null);
  const menuResults = useRef<HTMLDivElement>(null);
  const [removed, setRemoved] = useState<DraftItem | null>(null);
  const [noteEditor, setNoteEditor] = useState<{ clientRef: string; name: string; note: string } | null>(null);
  const [message, setMessage] = useState(() => carriedStatusFor(orderId));
  const [transferDialog, setTransferDialog] = useState<"move" | "merge" | null>(null);
  const [transferError, setTransferError] = useState("");
  const [transferSignal, setTransferSignal] = useState(0);
  const transferRefs = useRef(new Map<string, string>());
  useEffect(() => { if (order) savePreference("forkflow.order-type", order.type); }, [order?.type]);
  useEffect(() => {
    if (order?.type !== "parcel" || order.status !== "open") return;
    let active = true;
    apiFetch<{ orderTypes: OrderTypeInfo[] }>("/api/order-types")
      .then(({ orderTypes }) => { if (active) setTakeawayTypes(orderTypes.filter((t) => t.isActive && (t.kind === "takeaway" || t.kind === "delivery"))); })
      .catch(() => { /* the picker stays hidden; the order keeps its type */ });
    return () => { active = false; };
  }, [order?.id, order?.type, order?.status]);
  // Another device (or this one) folded this order into a different bill: follow it.
  const mergedInto = order?.mergedInto ?? null;
  useEffect(() => {
    if (!mergedInto) return;
    let current = true;
    apiFetch<{ order: Order }>(`/api/orders/${mergedInto}`).then(({ order: receiving }) => {
      if (!current) return;
      const label = orderLabel(receiving);
      // Unsaved cart items belong to this order's draft key and would be orphaned: say so, then drop them.
      const lostCart = readDraft().length > 0;
      const text = lostCart
        ? `This bill was merged into ${label}. Your unsaved items were not added — add them again on the combined bill.`
        : `Merged into ${label}`;
      if (lostCart) { localStorage.removeItem(draftKey); localStorage.removeItem(`forkflow.draft.${orderId}`); }
      setMessage(text);
      carryStatus(mergedInto, text, false);
      onOpenOrder(mergedInto);
    }).catch(() => { if (current) setMessage("This order was merged into another bill. Return to tables to find it."); });
    return () => { current = false; };
  }, [mergedInto]);
  useEffect(() => { if (!captain && order?.status === "open") menuSearch.current?.focus(); }, [order?.id, captain]);
  const focusCartOnSwitch = useRef(false);
  useEffect(() => {
    if (mobilePane === "cart" && focusCartOnSwitch.current) {
      cartItems.current?.focus();
      focusCartOnSwitch.current = false;
    }
  }, [mobilePane]);
  const isQuick = quickBilling && order?.type === "parcel" && userCan(user, "bills.settle");
  const locked = pending || billingBusy;
  const canLeave = () => {
    if (!actionLock.current && !billingLock.current) return true;
    window.alert("Wait for this order or payment to finish saving before leaving.");
    return false;
  };
  useNavigationGuard(canLeave);
  function holdOrder() {
    if (!canLeave()) return;
    if (isQuick && queuedRequests(user.id).some((request) => request.lane === orderId)) {
      setError("Review this order's saved actions before holding it and starting another takeaway.");
      return;
    }
    try {
      if (isQuick && onHold) onHold(); else onBack();
    } catch (error) { setError(error instanceof Error ? error.message : "Could not hold this order. Please retry."); }
  }
  useEffect(() => {
    if (!locked) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [locked]);

  /** This order's saved actions as the screen needs them: cart rows and kitchen items already saved, item changes waiting. */
  function laneState() {
    const entries = queuedRequests(user.id).filter((r) => r.lane === orderId);
    const bodyOf = (r: { body: string }): { items?: Array<{ clientRef: string }>; itemRefs?: string[] } => { try { return JSON.parse(r.body); } catch { return {}; } };
    return {
      entries,
      needsReview: entries.some((r) => r.status === "attention"),
      punchedRefs: new Set(entries.filter((r) => r.draftKey === draftKey).flatMap((r) => (bodyOf(r).items ?? []).map((item) => item.clientRef))),
      kitchenRefs: new Set(entries.filter((r) => r.path.endsWith("/send")).flatMap((r) => bodyOf(r).itemRefs ?? [])),
      itemActions: new Map(entries.flatMap((r) => { const m = /^\/api\/order-items\/([^/]+)\//.exec(r.path); return m ? [[m[1]!, r.label] as const] : []; })),
    };
  }
  const lane = laneState();
  const queuedRefs = lane.punchedRefs;

  /** Sends an action through the saved-actions queue. `null`: saved on this device, sent when the hub is back. */
  async function queued<T>(request: QueueRequest): Promise<T | null> {
    const outcome = await outcomeOrSaved(enqueueRequest<T>(request));
    return outcome.saved ? null : outcome.value;
  }
  /** Shows a change the hub has not confirmed yet, and keeps it in this device's copy of the order. */
  function keepLocally(next: Order) { setOrder(next); saveOrderCopy(user.id, next); }
  const WHEN_BACK = "sends when the connection returns";

  function show(current: Order, catalog: Omit<CatalogCache, "at">) {
    setOrder(current);
    setCaptains(catalog.captains);
    setCategories(catalog.categories.filter((cat) => cat.isActive));
    setProducts(catalog.products.filter((prod) => prod.isActive).map((prod) => ({ ...prod,
      pricePaise: priceForTier(prod, current.priceTier),
      variants: prod.variants.map((variant) => ({ ...variant, pricePaise: priceForTier(variant, current.priceTier) })),
    })));
    setSelectedCat((cur) => cur ?? catalog.categories.filter((x) => x.isActive)[0]?.id ?? null);
  }

  async function reload() {
    const revision = ++reloadRevision.current;
    let loaded: [{ order: Order }, { categories: Category[] }, { products: Product[] }, { captains: Array<{ id: string; name: string }> }];
    try {
      loaded = await Promise.all([
        apiFetch<{ order: Order }>(`/api/orders/${orderId}`),
        apiFetch<{ categories: Category[] }>("/api/categories"),
        apiFetch<{ products: Product[] }>("/api/products"),
        apiFetch<{ captains: Array<{ id: string; name: string }> }>("/api/captains"),
      ]);
    } catch (error) {
      // Unreachable hub, or an order started offline that the hub has not received yet: work from this device's copy.
      const notYetSent = error instanceof ApiError && error.status === 404 && queuedRequests(user.id).some((r) => r.path === "/api/orders" && r.lane === orderId);
      const copy = readOrderCopy(user.id, orderId), catalog = readCatalogCopy(user.id);
      if (!(isUnreachable(error) || notYetSent) || !copy || !catalog) throw error;
      if (revision !== reloadRevision.current) return;
      show(copy.order, catalog);
      setCopyAt(copy.at);
      return;
    }
    if (revision !== reloadRevision.current) return;
    const [o, c, p, staff] = loaded;
    const catalog = { categories: c.categories, products: p.products, captains: staff.captains };
    saveOrderCopy(user.id, o.order); saveCatalogCopy(user.id, catalog);
    setCopyAt(null);
    show(o.order, catalog);
  }

  useEffect(() => {
    reload().catch(() => setError("Failed to load order"));
    const refresh = () => { setDraft(readDraft()); refreshQueue((v) => v + 1); };
    const unsub = subscribeQueue(refresh);
    const acknowledged = () => { refresh(); void reload().catch(() => {}); };
    window.addEventListener("forkflow:ack", acknowledged);
    const dispose = connectWs({
      onEvent: (event, data) => {
        if (event === "order.updated" && (data as { order: Order }).order.id === orderId) void reload().catch(() => {});
        if (event === "table.changed") void reload().catch(() => {});
        if (event === "stock.changed") void reload().catch(() => {});
        if (event === "catalog.changed") void reload().catch(() => {});
        if (event === "kot.updated" && (data as { kot: { orderId: string } }).kot.orderId === orderId) void reload().catch(() => {});
      },
      onStatus: (connected) => { if (connected) void reload().catch(() => {}); },
      onAuthFail: () => session.clear(),
    });
    return () => { reloadRevision.current++; dispose(); unsub(); window.removeEventListener("forkflow:ack", acknowledged); };
  }, [orderId, draftKey, captain]);

  function saveDraft(next: DraftItem[]): boolean {
    try {
      localStorage.setItem(draftKey, JSON.stringify(next));
      localStorage.removeItem(`forkflow.draft.${orderId}`);
      setDraft(next); return true;
    } catch { setError("Cannot save this cart on the device. Free browser storage before adding items."); return false; }
  }

  async function run(action: () => Promise<unknown>) {
    if (actionLock.current || billingLock.current) return;
    actionLock.current = true; setPending(true); setError(""); setMessage("");
    try {
      await action();
      await reload().catch((e) => { if (!isUnreachable(e)) throw e; });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally { actionLock.current = false; setPending(false); }
  }

  function chooseOrderType(orderTypeId: string) {
    if (!order || orderTypeId === order.orderTypeId) return;
    void run(async () => {
      const result = await queued<{ order: Order }>({ method: "PATCH", path: `/api/orders/${order.id}/order-type`, body: { orderTypeId }, label: "Change order type" });
      if (result) { setOrder(result.order); setMessage(`Order type: ${result.order.orderTypeName ?? "Takeaway"}`); return; }
      const name = takeawayTypes.find((t) => t.id === orderTypeId)?.name ?? order.orderTypeName;
      keepLocally({ ...order, orderTypeId, orderTypeName: name });
      setMessage(`Order type ${name ?? ""} saved · ${WHEN_BACK}`);
    });
  }

  function chooseCaptain(captainId: string | null) {
    if (!order || actionLock.current || billingLock.current) return;
    if (captainId === (order.captainId ?? null)) { setCaptainPickerOpen(false); return; }
    setCaptainError("");
    void run(async () => {
      try {
        const result = await queued<{ order: Order }>({
          method: "PATCH", path: `/api/orders/${order.id}/captain`, body: { captainId, expectedCaptainId: order.captainId ?? null }, label: "Change captain",
        });
        setCaptainPickerOpen(false);
        if (result) { setOrder(result.order); setMessage(captainId ? "Captain saved for this order." : "Captain removed from this order."); return; }
        keepLocally({ ...order, captainId, captainName: captainId ? captains.find((c) => c.id === captainId)?.name ?? (captainId === user.id ? user.name : null) : null });
        setMessage(`Captain change saved · ${WHEN_BACK}`);
      } catch (error) {
        setCaptainError(error instanceof Error ? error.message : "Could not save captain. Please retry.");
        // Refresh stale assignments after conflicts without hiding the original error.
        await reload().catch(() => {});
        throw error;
      }
    });
  }

  function addToDraft(productId: string, variantId: string | null, name: string, pricePaise: number) {
    if (actionLock.current || billingLock.current) return;
    if (products.find((product) => product.id === productId)?.isSoldOut) {
      setError(`${name} is sold out and cannot be added to a new order.`); return;
    }
    if (queuedRequests(user.id).some((r) => r.path === `/api/orders/${orderId}/bill` && !r.error)) {
      setError("A bill is queued for this order. Wait for it to finish before starting another order."); return;
    }
    setMessage("");
    saveDraft([...readDraft(), { clientRef: uuid(), productId, variantId, name, pricePaise, qty: 1, note: "" }]);
  }

  function updateDraft(clientRef: string, update: Partial<Pick<DraftItem, "qty" | "note">>) {
    if (actionLock.current || billingLock.current) return;
    if (!queuedRefs.has(clientRef)) saveDraft(readDraft().map((item) => (item.clientRef === clientRef ? { ...item, ...update } : item)));
  }

  function removeDraft(clientRef: string) {
    if (actionLock.current || billingLock.current) return;
    if (!queuedRefs.has(clientRef)) {
      const current = readDraft();
      const item = current.find((row) => row.clientRef === clientRef);
      if (saveDraft(current.filter((row) => row.clientRef !== clientRef))) setRemoved(item ?? null);
    }
  }

  /** Adds the cart to the order. `saved`: the hub does not have every row yet (they are saved on this device). */
  async function punchDraft(): Promise<{ saved: boolean }> {
    const current = readDraft();
    const already = laneState().punchedRefs;
    const fresh = current.filter((d) => !already.has(d.clientRef));
    if (!fresh.length) return { saved: current.length > 0 };
    const items = fresh.map((d) => ({
      clientRef: d.clientRef,
      productId: d.productId,
      variantId: d.variantId,
      qty: d.qty,
      note: d.note || undefined,
    }));
    if (!saveDraft(current)) throw new Error("Cart could not be saved");
    const result = await queued({ path: `/api/orders/${orderId}/items`, body: { items }, label: `Add ${items.length} ${items.length === 1 ? "item" : "items"}`, draftKey });
    setDraft(readDraft());
    return { saved: result === null || already.size > 0 };
  }

  function punch() {
    if (!draft.length) return;
    void run(async () => { if ((await punchDraft()).saved) setMessage(`Items saved on this device · ${WHEN_BACK}`); });
  }

  /**
   * Adds the cart and sends everything waiting for a kitchen station. Works from this device's copy when the hub is
   * unreachable: items are named by the references the counter gave them, so the send can wait behind the punch.
   */
  async function sendPending(label: string): Promise<{ kots: number; printErrors: string[]; saved: boolean; none: boolean }> {
    if (!order) throw new Error("Order is still loading");
    if (laneState().needsReview) throw new Error("A saved action for this order needs review first. Open Saved actions above.");
    const cart = readDraft();
    const punched = await punchDraft();
    let current = order, catalog = products;
    if (!punched.saved) {
      try {
        const [o, p] = await Promise.all([apiFetch<{ order: Order }>(`/api/orders/${orderId}`), apiFetch<{ products: Product[] }>("/api/products")]);
        current = o.order; catalog = p.products;
      } catch (error) { if (!isUnreachable(error) && !(error instanceof ApiError && error.status === 404)) throw error; }
    }
    if (current.status !== "open") throw new Error("This order is no longer open. Return to tables to check its status.");
    const routed = new Set(catalog.filter((product) => product.kotStationId).map((product) => product.id));
    const waiting = laneState().kitchenRefs;
    const pendingItems = current.items.filter((item) => item.status === "pending" && routed.has(item.productId) && !(item.clientRef && waiting.has(item.clientRef)));
    const onOrder = new Set(current.items.map((item) => item.clientRef));
    const itemRefs = [
      ...pendingItems.flatMap((item) => item.clientRef ? [item.clientRef] : []),
      ...cart.filter((row) => routed.has(row.productId) && !onOrder.has(row.clientRef) && !waiting.has(row.clientRef)).map((row) => row.clientRef),
    ];
    const itemIds = pendingItems.filter((item) => !item.clientRef).map((item) => item.id);
    const outcome = { kots: 0, printErrors: [] as string[], saved: punched.saved, none: !itemRefs.length && !itemIds.length };
    for (const items of [itemIds.length ? { itemIds } : null, itemRefs.length ? { itemRefs } : null]) {
      if (!items) continue;
      const sent = await queued<{ kots: Array<{ id: string }>; printErrors?: string[] }>({ path: `/api/orders/${orderId}/send`, body: { clientRef: uuid(), ...items }, label });
      if (!sent) { outcome.saved = true; continue; }
      outcome.kots += sent.kots.length; outcome.printErrors.push(...(sent.printErrors ?? []));
    }
    return outcome;
  }

  async function prepareCheckout() {
    if (actionLock.current) throw new Error("Wait for the order to finish saving");
    actionLock.current = true; setPending(true); setError("");
    try {
      const sent = await sendPending("Send takeaway to kitchen");
      if (sent.saved) throw new Error("Saved on this device. Connect to the hub to review the bill.");
      await reload();
    } finally { actionLock.current = false; setPending(false); }
  }

  function cancelItem(item: OrderItem) {
    if (actionLock.current || billingLock.current) return;
    if (item.status === "pending") {
      if (!window.confirm(`Cancel ${item.name}?`)) return;
      void run(() => cancelSaved(item, {}));
    } else if (item.status === "sent") {
      if (!userCan(user, "orders.cancel_sent")) return;
      const reason = window.prompt(`Cancel ${item.name}?\nReason (required):`);
      if (!reason?.trim()) return;
      void run(() => cancelSaved(item, { reason: reason.trim() }));
    }
  }

  async function cancelSaved(item: OrderItem, body: { reason?: string }) {
    const result = await queued({ path: `/api/order-items/${item.id}/cancel`, body, label: `Cancel ${item.name}`, lane: orderId });
    if (result === null) setMessage(`Cancel of ${item.name} saved · ${WHEN_BACK}`);
  }

  /** Change a sent item's note, or (admin/cashier) cut its quantity. The removed units are cancelled with the reason. */
  function editSentItem(item: OrderItem) {
    if (actionLock.current || billingLock.current || item.status !== "sent") return;
    const canCut = userCan(user, "orders.cancel_sent");
    let qty = item.qty;
    if (canCut && item.qty > 1) {
      const raw = window.prompt(`${item.name}: new quantity (1 to ${item.qty}). To add more, add the dish again.`, String(item.qty));
      if (raw === null) return;
      qty = Number(raw.trim());
      if (!Number.isInteger(qty) || qty < 1 || qty > item.qty) { setError(`Enter a quantity from 1 to ${item.qty}`); return; }
    }
    const noteInput = window.prompt(`${item.name}: cooking note (leave blank for none)`, item.note ?? "");
    if (noteInput === null) return;
    const note = noteInput.trim() || null;
    if (qty === item.qty && note === (item.note ?? null)) return;
    let reason: string | undefined;
    if (qty < item.qty) {
      const value = window.prompt(`Reason for removing ${item.qty - qty} × ${item.name} (required):`);
      if (!value?.trim()) return;
      reason = value.trim();
    }
    void run(async () => {
      let rule: "ask" | "always" | "never" = "ask";
      try { ({ print: rule } = await apiFetch<{ print: "ask" | "always" | "never" }>("/api/kot-edit-settings")); }
      catch (error) { if (!isUnreachable(error)) throw error; }
      const print = rule === "ask" ? window.confirm("Print a CHANGED slip to the kitchen?") : rule === "always";
      const result = await queued<{ printError: string | null }>({ path: `/api/order-items/${item.id}/edit-sent`, lane: orderId, label: `Change ${item.name}`, body: {
        clientRef: uuid(), ...(qty !== item.qty ? { qty, reason } : {}), ...(note !== (item.note ?? null) ? { note } : {}), print,
      } });
      setMessage(result ? `${item.name} updated${result.printError ? `. Slip not printed: ${result.printError}` : ""}` : `Change to ${item.name} saved · ${WHEN_BACK}`);
    });
  }

  function sendToKitchen() {
    void run(async () => {
      const sent = await sendPending("Send to kitchen");
      if (sent.saved) setMessage(sent.none ? `Items saved on this device · ${WHEN_BACK}` : "Saved on this device · the kitchen ticket prints when the connection returns");
      else if (sent.none) setMessage("Order saved. No items are waiting for a kitchen ticket.");
      else setMessage(`Sent to kitchen · ${sent.kots} ${sent.kots === 1 ? "ticket" : "tickets"}${sent.printErrors.length ? `. Not printed: ${sent.printErrors.join("; ")}` : ""}`);
    });
  }

  async function newSplit() {
    if (actionLock.current || billingLock.current || !order) return;
    actionLock.current = true; setPending(true); setError("");
    try {
      // The counter chooses the new order's id, so the split opens at once even while the hub is unreachable.
      const id = uuid(), clientRef = uuid();
      const created = await queued<{ order: Order }>({ path: "/api/orders", body: { id, clientRef, type: "dine_in", tableId: order.tableId }, label: `New split on ${orderLabel(order)}` });
      if (!created) saveOrderCopy(user.id, placeholderOrder({ id, clientRef, userId: user.id, type: "dine_in",
        table: order.tableId ? { id: order.tableId, name: order.tableName ?? "", priceTier: order.priceTier as TableInfo["priceTier"] } : null }));
      onOpenOrder(id);
    } catch (e) { setError(e instanceof Error ? e.message : "Request failed"); }
    finally { actionLock.current = false; setPending(false); }
  }

  function openTransfer(kind: "move" | "merge") {
    if (actionLock.current || billingLock.current) return;
    setTransferError("");
    setTransferDialog(kind);
  }

  /** One lock and one client reference per intent; a retry of the same intent reuses its reference. */
  async function transfer(intent: string, request: (clientRef: string) => Promise<void>) {
    if (actionLock.current || billingLock.current) return;
    actionLock.current = true; setPending(true); setError(""); setMessage(""); setTransferError("");
    const clientRef = transferRefs.current.get(intent) ?? uuid();
    transferRefs.current.set(intent, clientRef);
    try {
      await request(clientRef);
      transferRefs.current.delete(intent);
    } catch (e) {
      if (e instanceof ApiError) transferRefs.current.delete(intent);
      setTransferError(e instanceof Error ? e.message : "Request failed");
      setTransferSignal((v) => v + 1);
      await reload().catch(() => {});
    } finally { actionLock.current = false; setPending(false); }
  }

  const printNote = (printErrors: string[]) => printErrors.length ? `. Not printed: ${printErrors.join("; ")}` : "";

  function moveTable(table: TableInfo) {
    if (!order) return;
    const kitchenInformed = order.kots.some((kot) => !kot.doneAt);
    void transfer(`move:${order.id}:${table.id}`, async (clientRef) => {
      const result = await apiFetch<{ order: Order; printErrors: string[] }>(`/api/orders/${order.id}/move`, {
        method: "POST", body: JSON.stringify({ clientRef, tableId: table.id }),
      });
      setOrder(result.order);
      setTransferDialog(null);
      setMessage(`Moved to ${table.name}${kitchenInformed ? " · kitchen notified" : ""}${printNote(result.printErrors)}`);
      await reload();
    });
  }

  /** Unsaved cart rows and queued requests this device holds for an order (same keys `readDraft` uses). */
  function heldCart(id: string) {
    let foldedDraftCount = 0;
    try {
      const rows: unknown = JSON.parse(localStorage.getItem(`forkflow.draft.${user.id}.${id}`) ?? localStorage.getItem(`forkflow.draft.${id}`) ?? "[]");
      foldedDraftCount = Array.isArray(rows) ? rows.length : 0;
    } catch { /* an unreadable draft is shown as empty, so it cannot block either */ }
    const foldedQueuedCount = queuedRequests(user.id).filter((request) => request.lane === id).length;
    return { foldedDraftCount, foldedQueuedCount };
  }

  function mergeOrders(choice: MergeChoice) {
    if (!order) return;
    // The order folded in is the one that stops existing; the other order keeps the bill. Only the folded
    // order's cart would be orphaned, so that is the cart that must be empty.
    const { keepsBill, foldedIn } = mergeRoles(order.id, choice);
    const blocked = mergeBlockedReason(heldCart(foldedIn));
    if (blocked) { setTransferError(blocked); return; }
    void transfer(`merge:${foldedIn}:${keepsBill}`, async (clientRef) => {
      const result = await apiFetch<{ order: Order; printErrors: string[] }>(`/api/orders/${foldedIn}/merge`, {
        method: "POST", body: JSON.stringify({ clientRef, targetOrderId: keepsBill }),
      });
      const text = `Merged · ${orderLabel(result.order)} billed together${printNote(result.printErrors)}`;
      setTransferDialog(null);
      if (keepsBill === order.id) { setOrder(result.order); setMessage(text); await reload().catch(() => {}); return; }
      carryStatus(keepsBill, text, true);
      onOpenOrder(keepsBill);
    });
  }

  function cancelOrder() {
    if (actionLock.current || billingLock.current || !window.confirm("Cancel this entire order?")) return;
    void run(async () => {
      await queued({ path: `/api/orders/${orderId}/cancel`, body: {}, label: "Cancel order" });
      onBack();
    });
  }

  function addNote(clientRef: string) {
    if (captain) {
      const row = readDraft().find((item) => item.clientRef === clientRef);
      if (row) setNoteEditor({ clientRef, name: row.name, note: row.note });
      return;
    }
    const note = window.prompt("Add note (e.g. less spicy):") ?? "";
    updateDraft(clientRef, { note });
  }

  if (!order) return <p className="loading-state" role="status">Loading order…</p>;
  const query = search.toLocaleLowerCase().trim();
  const activeProducts = products.filter((p) => (selectedCat === "all" || p.categoryId === selectedCat) && `${p.name} ${p.variants.map((v) => v.name).join(" ")}`.toLocaleLowerCase().includes(query));
  const hasSentItems = order.items.some((i) => i.status === "sent");
  const canCancelOrder = order.status === "open" && !hasSentItems;
  const total = order.items.filter((i) => i.status !== "cancelled").reduce((sum, i) => sum + i.pricePaise * i.qty, 0);
  // Drafts can survive a menu edit or application upgrade. Only saved order
  // lines have a price snapshot; show current service prices for unsaved lines.
  const pricedDraft = draft.map((item) => {
    const product = products.find((p) => p.id === item.productId);
    const priced = item.variantId ? product?.variants.find((v) => v.id === item.variantId) : product;
    return { ...item, pricePaise: priced?.pricePaise ?? item.pricePaise };
  });
  const draftTotal = order.status === "open" ? pricedDraft.reduce((sum, item) => sum + item.pricePaise * item.qty, 0) : 0;
  const itemCount = (order.status === "open" ? draft.reduce((sum, item) => sum + item.qty, 0) : 0) + order.items.filter((item) => item.status !== "cancelled").reduce((sum, item) => sum + item.qty, 0);
  const hasKitchenPending = order.items.some((item) => item.status === "pending" && products.some((product) => product.id === item.productId && product.kotStationId));
  const itemStatus = (item: OrderItem) => captain && item.status === "sent" && order.kots.some((kot) => kot.id === item.kotId && kot.doneAt) ? "ready" : item.status;

  return <section className="screen order-screen">
    <div className="page-header order-header">
      {captain && <button className="captain-back" {...shortcutProps("tables")} title={shortcut("tables", "Return to tables")} aria-label="Return to tables" disabled={locked} onClick={() => { if (canLeave()) onBack(); }}>←</button>}
      <div><h2>{order.type === "dine_in" ? `${orderLabel(order)} · ${order.splitLabel ?? "A"}` : order.type === "zomato" ? zomatoLabel(order.zomatoOrderId) : order.orderTypeName ?? "Takeaway"}<span className={`status ${order.status}`}>{order.status}</span>{lane.entries.length > 0 && <span className={`status saved-actions${lane.needsReview ? " attention" : ""}`} title="Saved on this device, waiting to reach the hub">{lane.needsReview ? "Needs review" : `${lane.entries.length} saved`}</span>}</h2>
        {/* Captains serve their own tables; reassigning is a counter decision. */}
        {user.role === "waiter" && order.type === "dine_in" && order.status === "open" && !order.captainName ? <div className="order-captain-picker">
          <span>Captain</span>
          <button type="button" disabled={locked} onClick={() => chooseCaptain(user.id)}>Assign to me</button>
        </div> : user.role !== "waiter" && order.type === "dine_in" && order.status === "open" ? <div className="order-captain-picker">
          <span>Captain</span>
          <button type="button" aria-label="Captain for this order" aria-haspopup="dialog" aria-expanded={captainPickerOpen} disabled={locked}
            onClick={() => { setCaptainError(""); setCaptainPickerOpen(true); }}>
            <span>{order.captainName || "Select captain"}</span><span aria-hidden="true">⌄</span>
          </button>
        </div> : order.captainName && <p className="muted">Captain: {order.captainName}</p>}
        {!captain && crm && <OrderCustomer order={order} canAdd={userCan(user, "customers.manage")} disabled={locked} onSaved={(saved) => { setOrder(saved); setMessage(saved.customer ? `Customer: ${saved.customer.name}` : "Customer removed."); }} />}
        {order.type === "parcel" && order.status === "open" && takeawayTypes.length > 1 && <label className="order-type-picker">Order type <select value={order.orderTypeId} disabled={locked} onChange={(e) => chooseOrderType(e.target.value)}>
          {takeawayTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select></label>}
        {isQuick && order.status === "open" && <p className="muted">Select items, then checkout. Kitchen items are sent automatically.</p>}</div>
      {captain ? <OverflowMenu label="More">
        {order.status === "open" && <button {...shortcutProps("hold")} title={shortcut("hold", "Hold and return to tables")} disabled={locked} onClick={() => { if (canLeave()) onBack(); }}>Hold & return to tables</button>}
        {order.status === "open" && draft.length > 0 && <button disabled={locked} {...shortcutProps("save_items")} title={shortcut("save_items", "Save without sending to kitchen")} onClick={punch}>Save items only</button>}
        {order.type === "dine_in" && order.status === "open" && <button disabled={locked} onClick={() => void newSplit()}>New split on this table</button>}
        {order.type === "dine_in" && order.status === "open" && <button disabled={locked} onClick={() => openTransfer("move")}>Move table…</button>}
        {order.type === "dine_in" && order.status === "open" && <button disabled={locked} onClick={() => openTransfer("merge")}>Merge…</button>}
        {canCancelOrder && <button disabled={locked} onClick={cancelOrder}>Cancel order</button>}
      </OverflowMenu> : <div className="actions">
      <TerminalClock />
      <span className="pos-order-meta">{PRICE_TIER_LABELS[order.priceTier]} · {user.name}</span>
      {order.status === "open" && <button {...shortcutProps("hold")} title={shortcut("hold", isQuick ? "Keep this order in Open takeaways and free Takeaway for the next customer" : "Hold this order and return to tables")} disabled={locked} onClick={holdOrder}>{shortcut("hold", "Hold")}</button>}
      {order.type === "dine_in" && order.status === "open" && <button onClick={() => void newSplit()} disabled={locked}>+ Split</button>}
      {order.type === "dine_in" && order.status === "open" && <button onClick={() => openTransfer("move")} disabled={locked}>Move table…</button>}
      {order.type === "dine_in" && order.status === "open" && <button onClick={() => openTransfer("merge")} disabled={locked}>Merge…</button>}
      <button {...shortcutProps("tables")} title={shortcut("tables", "Return to tables / choose another table")} disabled={locked} onClick={() => { if (canLeave()) onBack(); }}>← Tables</button>
      </div>}
    </div>
    <WorkspaceDialog open={captainPickerOpen} title="Choose captain" className="order-captain-dialog" busy={locked}
      onClose={() => { if (!actionLock.current && !billingLock.current) setCaptainPickerOpen(false); }}>
      <p>Captain for {orderLabel(order)} · {order.splitLabel ?? "A"}</p>
      {captainError && <div className="error-message" role="alert">{captainError}</div>}
      {order.status !== "open" ? <p role="status">This order is no longer open. Captain assignment is closed.</p> : <>
        {order.captainId && !captains.some((c) => c.id === order.captainId) && <p className="muted">{order.captainName} is inactive. Choose another captain or remove the assignment.</p>}
        {!captains.length && <p className="muted">No active captains. Add or activate a Captain / waiter in Users &amp; captains.</p>}
        <div className="order-captain-options" role="group" aria-label="Available captains" aria-busy={pending}>
          {captains.map((c) => <button type="button" key={c.id} disabled={locked} aria-pressed={order.captainId === c.id} onClick={() => chooseCaptain(c.id)}>
            <span>{c.name}</span>{order.captainId === c.id && <span className="muted">Selected</span>}
          </button>)}
          <button type="button" disabled={locked} aria-pressed={!order.captainId} onClick={() => chooseCaptain(null)}>
            <span>No captain</span>{!order.captainId && <span className="muted">Selected</span>}
          </button>
        </div>
        {pending && <p role="status">Saving captain…</p>}
      </>}
    </WorkspaceDialog>
    <MoveTableDialog open={transferDialog === "move" && order.status === "open"} order={order} busy={locked} error={transferError} refreshSignal={transferSignal}
      onClose={() => { if (!actionLock.current && !billingLock.current) setTransferDialog(null); }} onConfirm={moveTable} />
    <MergeOrderDialog open={transferDialog === "merge" && order.status === "open"} order={order} busy={locked} error={transferError} refreshSignal={transferSignal}
      onClose={() => { if (!actionLock.current && !billingLock.current) setTransferDialog(null); }} onConfirm={mergeOrders} />
    <div className="error-message" role="alert">{error}</div>
    {copyAt !== null && <p className="alert offline-banner" role="status">Working offline · showing this device's copy from {new Date(copyAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. Actions are saved and sent when the connection returns.</p>}
    {order.status !== "settled" && order.status !== "cancelled" && order.stockWarnings?.length > 0 && <details className="alert order-stock-warning">
      <summary>Low stock · {order.stockWarnings.length} ingredients. Ordering is still available.</summary><ul>{order.stockWarnings.map((item) => <li key={item.id}>{item.name}: {item.qty} {item.unit} remaining</li>)}</ul>
    </details>}
    {order.status === "open" && <div className="order-pane-switch" aria-label="Order view">
      <button aria-pressed={mobilePane === "menu"} aria-controls="order-menu" onClick={() => setMobilePane("menu")}>Menu</button>
      <button aria-pressed={mobilePane === "cart"} aria-controls="order-cart" onClick={() => setMobilePane("cart")}>Order · {itemCount}</button>
    </div>}
    <div className={`order-layout ${order.status === "open" ? `show-${mobilePane}` : "closed-order"}`}>
      {order.status === "open" && <section className="menu-browser" id="order-menu" aria-label="Menu">
        <div className="menu-toolbar">
          <div className="menu-heading"><h3>Menu</h3><span>{PRICE_TIER_LABELS[order.priceTier]} prices · {activeProducts.length} dishes</span></div>
          <div className="search-field"><Icon name="search" size={16} /><input ref={menuSearch} autoFocus={!captain} aria-label="Search menu" placeholder={captain ? "Search dishes or variants" : "Search items · Enter to add"} value={search} onChange={(e) => { setSearch(e.target.value); if (e.target.value) setSelectedCat("all"); }} onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") { event.preventDefault(); menuResults.current?.querySelector<HTMLButtonElement>("button.menu-card:not(:disabled)")?.click(); }
            if (event.key === "Escape") { event.preventDefault(); setSearch(""); }
          }} /></div>
          <span className="pos-search-hint">Enter adds first match</span>
        </div>
        <div className="category-rail" role="group" aria-label="Menu categories">
          <button aria-pressed={selectedCat === "all"} onClick={() => setSelectedCat("all")}>All items</button>
          {categories.map((category) => <button key={category.id} title={category.name} aria-pressed={selectedCat === category.id} onClick={() => setSelectedCat(category.id)}>{category.name}</button>)}
        </div>
        <div className="menu-results" ref={menuResults} role="region" tabIndex={0} aria-label="Menu items"><div className="menu-grid">{activeProducts.flatMap((p) => {
          const variants = p.variants.filter((v) => v.isActive);
          const top = <div className="menu-card-top"><span className={`veg-indicator ${p.isVeg ? "" : "non-veg"}`}>{p.isVeg ? "VEG" : "NON-VEG"}</span>{p.isSoldOut && <span className="menu-sold-out-label">Sold out</span>}</div>;
          return variants.length ? variants.map((v) => <button className={`menu-card${p.isSoldOut ? " sold-out" : ""}`} disabled={p.isSoldOut || locked} aria-label={`${p.isSoldOut ? "Sold out:" : "Add"} ${p.name}, ${v.name}, ₹${paiseToRupees(v.pricePaise)}`} key={`${p.id}.${v.id}`} onClick={() => addToDraft(p.id, v.id, `${p.name} (${v.name})`, v.pricePaise)}>{top}<div className="menu-card-name">{p.name}<small className="menu-card-portion">{v.name}</small></div><div className="menu-card-bottom"><span>₹{paiseToRupees(v.pricePaise)}</span><span className="add-indicator"><Icon name="plus" size={16} /></span></div></button>)
          : [<button className={`menu-card${p.isSoldOut ? " sold-out" : ""}`} disabled={p.isSoldOut || locked} key={p.id} onClick={() => addToDraft(p.id, null, p.name, p.pricePaise)}>{top}<div className="menu-card-name">{p.name}</div><div className="menu-card-bottom"><span>₹{paiseToRupees(p.pricePaise)}</span><span className="add-indicator"><Icon name="plus" size={16} /></span></div></button>];
        })}</div>
        {!activeProducts.length && <div className="empty-state"><Icon name="search" size={32} /><h3>No menu items found</h3><p>Try another name or category.</p></div>}</div>
      </section>}
      <aside className="order-cart" id="order-cart" aria-label="Current order">
        <div className="cart-heading"><h3>Current order <span>{itemCount} items</span></h3><Icon name={order.type === "dine_in" ? "tables" : "bag"} size={17} /></div>
        <div className="cart-items" ref={cartItems} role="region" tabIndex={0} aria-label="Order items">
        {order.status === "open" && (draft.length > 0 || order.items.length === 0) && <div className="cart-section">
          <h3>{captain ? "Not sent" : "Cart"} ({draft.length} items)</h3>
          {!draft.length && <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Select a dish.</p>}
          {pricedDraft.map((d) => <div className="cart-row draft-row" key={d.clientRef}>
            <button className="cart-item-name" title={d.note ? d.name + ": " + d.note : "Add note for " + d.name} aria-label={"Note for " + d.name} disabled={locked || queuedRefs.has(d.clientRef)} onClick={() => addNote(d.clientRef)}><strong>{d.name}</strong>{d.note ? <small>{d.note}</small> : captain && <small>Add cooking note</small>}</button>
            <QtyStepper name={d.name} value={d.qty} disabled={locked || queuedRefs.has(d.clientRef)} onChange={(qty) => updateDraft(d.clientRef, { qty })} />
            <span className="pos-money">₹{paiseToRupees(d.pricePaise * d.qty)}</span>
            <button className="cart-remove" title={"Remove " + d.name} aria-label={"Remove " + d.name} disabled={locked || queuedRefs.has(d.clientRef)} onClick={() => removeDraft(d.clientRef)}>×</button>
            {queuedRefs.has(d.clientRef) && <small className="cart-row-notice">{lane.kitchenRefs.has(d.clientRef) ? "Saved · goes to the kitchen when back online" : "Saved to send"}</small>}
          </div>)}
        </div>}
        {order.items.length > 0 && <div className="cart-section">
          <h3>{captain ? "Saved items" : "Punched items"}</h3>
          {order.items.map((item) => <div className="cart-row saved-row" key={item.id} style={{ opacity: item.status === "cancelled" ? .5 : 1 }}>
            <div className="saved-item-name"><strong>{item.qty} × {item.name}</strong><span className={`status ${itemStatus(item)}`}>{itemStatus(item)}</span>{item.note && <small>{item.note}</small>}{item.cancelReason && <small className="danger-text">Cancelled: {item.cancelReason}</small>}{lane.itemActions.has(item.id) ? <small className="cart-row-notice">{lane.itemActions.get(item.id)} · saved</small> : item.clientRef && lane.kitchenRefs.has(item.clientRef) && <small className="cart-row-notice">Kitchen send saved</small>}</div>
            <span className="pos-money">₹{paiseToRupees(item.pricePaise * item.qty)}</span>
            {order.status === "open" && item.status === "sent" && <button className="saved-item-edit" title={"Change " + item.name} aria-label={"Change " + item.name} disabled={locked} onClick={() => editSentItem(item)}>Edit</button>}
            {order.status === "open" && item.status !== "cancelled" && (item.status === "pending" || userCan(user, "orders.cancel_sent")) && <button className="saved-item-cancel" title={"Cancel " + item.name} aria-label={"Cancel " + item.name} disabled={locked} onClick={() => cancelItem(item)}>×</button>}
          </div>)}
        </div>}
        </div>
        <div className="cart-footer">
        {message && <p className="captain-message" role="status"><Icon name="check" size={16} />{message}</p>}
        {removed && order.status === "open" && <div className="pos-undo" role="status"><span>{removed.name} removed</span><button disabled={locked} onClick={() => { if (locked || queuedRefs.has(removed.clientRef)) return; const current = readDraft(); if (!current.some((row) => row.clientRef === removed.clientRef) && saveDraft([...current, removed])) setRemoved(null); }}>Undo</button><button aria-label="Dismiss undo" title="Dismiss" onClick={() => setRemoved(null)}>×</button></div>}
        <div className="cart-total"><div><span>Items subtotal</span><span>₹{paiseToRupees(total + draftTotal)}</span></div>{order.status === "open" && draft.length > 0 && <p>Includes ₹{paiseToRupees(draftTotal)} in cart</p>}</div>
        {order.status === "open" && (captain ? <div className="cart-actions captain-send"><button className="primary button-icon" {...shortcutProps("send_kitchen")} title={shortcut("send_kitchen", "Save items and send to kitchen")} onClick={sendToKitchen} disabled={locked || (!draft.length && !hasKitchenPending)}><Icon name="kitchen" size={16} />{pending ? "Saving & sending…" : "Send to kitchen"}</button></div> : <div className="cart-actions">{!isQuick && draft.length > 0 && <button className="primary" {...shortcutProps("save_items")} title={shortcut("save_items", "Save draft items to order")} onClick={punch} disabled={locked}>{shortcut("save_items", "Punch")}</button>}{!isQuick && <button className="primary soft button-icon" {...shortcutProps("send_kitchen")} title={shortcut("send_kitchen", "Save items and send to kitchen")} onClick={sendToKitchen} disabled={locked || (!draft.length && !hasKitchenPending)}><Icon name="kitchen" size={15} />{shortcut("send_kitchen", "KOT")}</button>}{canCancelOrder && <button className="text-button" onClick={cancelOrder} disabled={locked}>Cancel order</button>}</div>)}
        {!captain && userCan(user, "bills.create") && <BillingPanel role={user.role} order={order} hasDraft={draft.length > 0} onChanged={reload} onPrepare={isQuick ? prepareCheckout : undefined} disabled={pending} onGoToTables={order.type === "dine_in" ? () => { if (canLeave()) onBack(); } : undefined} onClosed={() => { if (canLeave()) onBack(); }} onBusyChange={(value) => { billingLock.current = value; setBillingBusy(value); }} />}
        {isQuick && order.status === "settled" && onNextTakeaway && <button className="primary next-takeaway" {...shortcutProps("takeaway")} title={shortcut("takeaway", "Next takeaway")} disabled={locked} onClick={() => { if (canLeave()) onNextTakeaway(); }}>Next takeaway</button>}
        </div>
      </aside>
    </div>
    {order.status === "open" && mobilePane === "menu" && <button className="mobile-cart-link" onClick={() => { focusCartOnSwitch.current = true; setMobilePane("cart"); }}><span>{captain ? "Review order" : "View cart"} · {itemCount} items</span><strong>₹{paiseToRupees(total + draftTotal)}</strong></button>}
    {captain && <WorkspaceDialog open={noteEditor !== null} title={`Cooking note${noteEditor ? ` · ${noteEditor.name}` : ""}`} onClose={() => setNoteEditor(null)} busy={locked} className="captain-dialog captain-note-dialog">
      {noteEditor && <form onSubmit={(event) => { event.preventDefault(); if (locked || queuedRefs.has(noteEditor.clientRef)) return; updateDraft(noteEditor.clientRef, { note: noteEditor.note.trim() }); setNoteEditor(null); }}>
        <label>Instructions for the kitchen<textarea aria-label="Cooking instructions" maxLength={200} rows={3} disabled={locked} value={noteEditor.note} onChange={(event) => setNoteEditor({ ...noteEditor, note: event.target.value })} /></label>
        <div className="captain-note-chips">{["Less spicy", "No onion", "No garlic"].map((note) => <button type="button" key={note} disabled={locked} onClick={() => setNoteEditor({ ...noteEditor, note: [noteEditor.note, note].filter(Boolean).join(", ").slice(0, 200) })}>{note}</button>)}</div>
        <small>{noteEditor.note.length}/200</small><div className="captain-note-actions"><button type="button" onClick={() => setNoteEditor(null)}>Cancel</button><button className="primary" disabled={locked}>Save note</button></div>
      </form>}
    </WorkspaceDialog>}
  </section>;
}
