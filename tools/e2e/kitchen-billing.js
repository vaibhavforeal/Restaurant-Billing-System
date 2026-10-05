// Run on the disposable captain-server fixture, signed in as admin at /.
// After this script returns, accept the ticket in a separate kitchen session,
// then run window.__kitchenBillingGate.afterAcceptance().
(async () => {
  if (location.origin !== "http://127.0.0.1:4139") throw new Error("Disposable captain fixture required");
  const checks = [];
  const check = (ok, label) => { if (!ok) throw new Error(label); checks.push(label); };
  const wait = async (fn, label) => {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      const result = await fn();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out: ${label}`);
  };
  const button = (text) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim().replace(/ · (?:Shift\+)?F\d+$/, "") === text);
  const click = async (text) => {
    const target = await wait(() => button(text), text);
    if (target.disabled) throw new Error(`Disabled: ${text}`);
    target.click();
  };
  const api = async (path, method = "GET", body) => {
    const response = await fetch(path, { method, headers: {
      authorization: `Bearer ${localStorage.getItem("forkflow.token")}`,
      "x-forkflow-device": localStorage.getItem("forkflow.device.v1"),
      "content-type": "application/json",
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, ...(await response.json()) };
  };
  const previewButton = () => document.querySelector(".billing-footer-actions .pos-pay");
  const table = (await api("/api/tables")).tables.find((t) => t.status === "free");
  if (!table) throw new Error("Unused fixture table required");
  if (!button("tables")?.disabled) await click("tables");
  (await wait(() => [...document.querySelectorAll(".table-card")].find((card) => card.querySelector("strong")?.textContent === table.name), "table card")).click();
  await wait(previewButton, "billing panel");
  await click("All items");
  (await wait(() => [...document.querySelectorAll(".menu-card")].find((card) => card.querySelector(".menu-card-name")?.textContent.trim() === "Paneer tikka"), "kitchen item")).click();
  const kotButton = await wait(() => [...document.querySelectorAll(".cart-actions button")].find((b) => b.textContent.includes("KOT") && !b.disabled), "send KOT");
  kotButton.click();
  await wait(() => document.querySelector(".captain-message")?.textContent.includes("Sent to kitchen"), "send acknowledged");
  const order = (await api("/api/orders")).orders.find((o) => o.tableId === table.id);
  check(order.kots.length === 1 && order.kots[0].acceptedAt === null, "New KOT starts unaccepted");
  await wait(() => previewButton()?.disabled && document.querySelector(".billing-kitchen-wait"), "billing blocked");
  check(document.querySelector(".billing-kitchen-wait").textContent.includes(`#${order.kots[0].kotNo}`), "Billing explains which KOT is waiting");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  check(previewButton()?.disabled && !document.querySelector(".billing-dialog")?.open, "Billing shortcut cannot bypass kitchen acceptance");
  for (const endpoint of ["bill-preview", "bill"]) {
    const response = await api(`/api/orders/${order.id}/${endpoint}`, "POST", { clientRef: crypto.randomUUID(), previewKey: "a".repeat(64) });
    check(response.status === 409 && response.error.includes("accept all tickets"), `${endpoint} API rejects an unaccepted table KOT`);
  }
  check((await api(`/api/orders/${order.id}/bill`)).bill === null, "Blocked requests create no bill");
  window.__kitchenBillingGate = {
    orderId: order.id, kotId: order.kots[0].id, kotNo: order.kots[0].kotNo, tableName: table.name,
    async afterAcceptance() {
      await wait(() => !previewButton()?.disabled && !document.querySelector(".billing-kitchen-wait"), "live billing unlock");
      check(true, "Kitchen acceptance unlocks billing over WebSocket without reloading");
      const accepted = (await api(`/api/orders/${order.id}`)).order;
      check(accepted.kots[0].acceptedAt != null && accepted.kots[0].doneAt === null, "Acceptance unlocks billing before Done");
      previewButton().click();
      await wait(() => button("Issue bill") && !button("Issue bill").disabled, "reviewed preview");
      await click("Issue bill");
      await wait(() => button("Record payment"), "issued bill");
      const bill = (await api(`/api/orders/${order.id}/bill`)).bill;
      check(bill?.status === "unpaid" && bill.totalPaise === 12600, "Accepted table order issues its correct bill through the UI");
      window.__kitchenBillingResult = { status: "passed", checks, billNo: bill.billNo };
      return window.__kitchenBillingResult;
    },
  };
  return { status: "awaiting-kitchen-acceptance", checks, tableName: table.name, kotNo: order.kots[0].kotNo };
})();
