// Run via agent-browser eval --stdin on the disposable Captain fixture, signed in as Ravi.
(async () => {
  if (location.origin !== "http://127.0.0.1:4139") throw new Error("Disposable Captain fixture required");
  const pause = (ms = 80) => new Promise(resolve => setTimeout(resolve, ms));
  const visible = e => e && e.getClientRects().length && getComputedStyle(e).visibility !== "hidden";
  const wait = async (fn, label) => { for (let i = 0; i < 200; i++) { const value = fn(); if (value) return value; await pause(); } throw new Error("Timed out: " + label); };
  const scope = () => document.querySelector("dialog[open]") || document;
  const button = text => [...scope().querySelectorAll("button")].find(e => visible(e) && !e.disabled && (e.textContent.trim() === text || e.getAttribute("aria-label") === text));
  const click = async text => { (await wait(() => button(text), text)).click(); await pause(); };
  const fill = (input, value) => { Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value").set.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); };
  const check = (value, label) => { if (!value) throw new Error(label); };
  await wait(() => document.querySelector(".menu-card"), "menu");
  await click("All items");
  for (const name of ["Paneer tikka", "Crispy corn", "Fresh lime"]) {
    const tile = [...document.querySelectorAll(".menu-card")].find(e => e.querySelector(".menu-card-name")?.textContent.trim() === name);
    check(tile, "Missing " + name); tile.click(); await pause();
  }
  await click("Add Vegetable biryani, Large, ₹240.00");
  const quantity = document.querySelector('input[aria-label="Quantity of Paneer tikka"]');
  fill(quantity, "2"); await pause(); quantity.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await pause();
  await click("Note for Paneer tikka");
  fill(scope().querySelector("textarea"), "Less spicy"); await pause(); await click("Save note");
  check(document.querySelector(".cart-total").textContent.includes("630.00"), "Unchanged sum of item prices: ₹630.00");
  await click("Remove Crispy corn"); await click("Undo");
  await click("Send to kitchen");
  await wait(() => document.querySelector(".captain-message")?.textContent.includes("Sent to kitchen"), "KOT acknowledgement");
  const headers = { authorization: "Bearer " + localStorage.getItem("forkflow.token"), "x-forkflow-device": localStorage.getItem("forkflow.device.v1") };
  const orders = await fetch("/api/orders", { headers }).then(r => r.json());
  const order = orders.orders.find(o => o.tableName === "T01");
  check(order.items.length === 4, "Four saved rows without duplicates");
  check(order.items.filter(i => i.status === "sent").length === 3, "Three kitchen rows sent");
  check(order.items.find(i => i.name === "Paneer tikka")?.qty === 2, "Typed quantity persisted");
  check(order.items.find(i => i.name === "Paneer tikka")?.note === "Less spicy", "Cooking note persisted");
  check(order.items.reduce((total, i) => total + i.pricePaise * i.qty, 0) === 63000, "₹630.00 subtotal unchanged");
  check(order.kots.length === 1, "One KOT created");
  const denied = await fetch(`/api/orders/${order.id}/bill-preview`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" });
  check(denied.status === 403, "Waiter cannot bill");
  let prints;
  for (let i = 0; i < 40; i++) { prints = await fetch("/__qa/prints").then(r => r.json()); if (prints.prints.some(text => text.includes("Less spicy"))) break; await pause(150); }
  check(prints.prints.some(text => text.includes("Less spicy") && text.includes("Paneer tikka")), "KOT reaches existing printer queue with note");
  const registration = await navigator.serviceWorker.ready;
  const cached = [];
  for (const key of await caches.keys()) { for (const request of await (await caches.open(key)).keys()) cached.push(new URL(request.url).pathname); }
  check(!cached.some(path => path.startsWith("/api/")), "No API data cached by PWA");
  const result = { orderId: order.id, kotId: order.kots[0].id, itemRows: order.items.length, kitchenRows: 3, subtotalPaise: 63000, printed: true, waiterBillingDenied: true, workerScope: registration.scope, cachedAssets: cached.length };
  localStorage.setItem("forkflow.qa.captain", JSON.stringify(result));
  return result;
})();
