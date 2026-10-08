// Run on the isolated ForkFlow Demo, signed in as admin at /.
// Sends a table KOT and bills it straight away: billing never waits for the kitchen.
// The ticket stays open on the Kitchen Display for tools/e2e/kitchen-app.js.
(async () => {
  if (location.origin !== "http://127.0.0.1:4110") throw new Error("Isolated demo on port 4110 required");
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
  const integrations = (await api("/api/integrations")).integrations;
  check(integrations.find((i) => i.id === "kds")?.enabled === true, "Demo starts with the Kitchen Display turned on");
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
  check(order.kots.length === 1 && order.kots[0].doneAt === null, "New KOT is open on the Kitchen Display");
  check(!("kitchenAcceptanceRequired" in order), "Orders carry no kitchen-acceptance flag");
  await wait(() => previewButton() && !previewButton().disabled, "billing available");
  check(!document.querySelector(".billing-kitchen-wait"), "Billing shows no kitchen wait");
  previewButton().click();
  await wait(() => button("Issue bill") && !button("Issue bill").disabled, "reviewed preview");
  await click("Issue bill");
  await wait(() => button("Record payment"), "issued bill");
  const bill = (await api(`/api/orders/${order.id}/bill`)).bill;
  check(bill?.status === "unpaid" && bill.totalPaise === 23100, "A table with an open KOT is billed straight away");
  const after = (await api(`/api/orders/${order.id}`)).order;
  check(after.kots[0].doneAt === null, "Billing does not complete the kitchen ticket");
  window.__demoKitchenResult = { status: "passed", checks, tableName: table.name, kotNo: order.kots[0].kotNo };
  return window.__demoKitchenResult;
})();
