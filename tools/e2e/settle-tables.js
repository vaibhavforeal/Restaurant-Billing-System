// Run with agent-browser eval --stdin in the disposable report fixture as admin.
(async () => {
  const checks = [];
  const assert = (value, label) => { if (!value) throw new Error(label); checks.push(label); };
  const wait = async (check) => { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise((r) => setTimeout(r, 50)); } throw new Error("UI wait timed out"); };
  const buttons = (text) => [...document.querySelectorAll("button")].filter((b) => b.textContent.trim() === text);
  const api = async (path, body) => {
    const response = await fetch(path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", authorization: `Bearer ${localStorage.getItem("forkflow.token")}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error(await response.text()); return response.json();
  };
  const category = (await api("/api/categories", { name: "Settlement navigation test" })).category;
  const product = (await api("/api/products", { name: "Test meal", categoryId: category.id, pricePaise: 10000, gstRate: 5, kotStationId: null })).product;
  const table = (await api("/api/tables")).tables.find((t) => t.name === "T2");
  for (const split of [false, true]) {
    const { order } = await api("/api/orders", { clientRef: crypto.randomUUID(), type: "dine_in", tableId: table.id });
    await api(`/api/orders/${order.id}/items`, { items: [{ clientRef: crypto.randomUUID(), productId: product.id, qty: 1 }] });
    const { preview } = await api(`/api/orders/${order.id}/bill-preview`, {});
    const { bill } = await api(`/api/orders/${order.id}/bill`, { clientRef: crypto.randomUUID(), previewKey: preview.previewKey });
    const nav = buttons("tables")[0]; if (nav && !nav.disabled) nav.click();
    await wait(() => [...document.querySelectorAll(".table-card")].some((b) => b.textContent.includes("T2")));
    [...document.querySelectorAll(".table-card")].find((b) => b.textContent.includes("T2")).click();
    await wait(() => buttons("Record payment").length > 0);
    assert(buttons("Go to tables").length === 0, `${split ? "Split" : "Single"}: no paid navigation before settlement`);
    let remaining;
    if (split) remaining = (await api("/api/orders", { clientRef: crypto.randomUUID(), type: "dine_in", tableId: table.id })).order;
    buttons("Record payment")[0].click();
    await wait(() => document.querySelector("dialog[open]"));
    const settle = [...document.querySelectorAll("dialog[open] button")].find((b) => b.textContent.includes("Settle bill"));
    assert(settle && !settle.disabled, "Settlement is ready with the exact payment amount");
    settle.click();
    await wait(() => [...document.querySelectorAll("dialog[open] button")].some((b) => b.textContent.trim() === "Go to tables" && !b.disabled));
    assert((await api(`/api/bills/${bill.id}`)).bill.status === "paid", "Payment persisted before Go to tables becomes available");
    const go = [...document.querySelectorAll("dialog[open] button")].find((b) => b.textContent.trim() === "Go to tables");
    go.click();
    await wait(() => document.querySelector(".table-card"));
    assert(!document.querySelector("dialog[open]"), "Go to tables closes billing and returns to the table view");
    const updated = (await api("/api/tables")).tables.find((t) => t.id === table.id);
    assert(updated.status === (split ? "occupied" : "free"), split ? "Remaining split keeps the table occupied" : "Fully settled table is available");
    if (remaining) await api(`/api/orders/${remaining.id}/cancel`, { reason: "Test cleanup" });
  }
  const result = { status: "passed", count: checks.length, checks };
  window.__settleTablesResult = result;
  return result;
})()
