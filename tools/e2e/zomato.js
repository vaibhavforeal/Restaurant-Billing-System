// Run in the disposable zomato-server fixture, signed in as admin.
(async () => {
  if (location.origin !== "http://127.0.0.1:4177") throw new Error("Disposable Zomato fixture required");
  const checks = [];
  const check = (ok, message) => { if (!ok) throw new Error(message); checks.push(message); };
  const wait = async (fn, message) => {
    const end = Date.now() + 10000;
    while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error(`Timed out: ${message}`);
  };
  const button = text => [...document.querySelectorAll("button")].find(b => b.textContent.trim() === text);
  const set = (element, value) => {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  };
  const api = async path => {
    const response = await fetch(path, { headers: { authorization: `Bearer ${localStorage.getItem("forkflow.token")}`, "x-forkflow-device": localStorage.getItem("forkflow.device.v1") } });
    if (!response.ok) throw new Error(`API ${response.status}`);
    return response.json();
  };
  if (!document.querySelector(".zomato-screen")) button("zomato").click();
  await wait(() => button("Reconciliation"), "workspace tabs"); button("Reconciliation").click();
  await wait(() => document.querySelectorAll(".zomato-table tbody tr").length === 6 && !button("Refresh").disabled, "seeded reconciliation");
  check(document.querySelector(".zomato-status").textContent.includes("Live activation pending"), "Unconfigured live status is explicit");
  check(document.querySelector(".zomato-metrics").textContent.includes("₹1144.01"), "Exact statement net is shown");
  set(document.querySelector('input[type="search"]'), "000102");
  await wait(() => document.querySelectorAll(".zomato-table tbody tr").length === 1, "order search");
  check(document.querySelector(".zomato-table tbody").textContent.includes("₹-20.00"), "Underpayment is visible after searching");
  const createUrl = URL.createObjectURL;
  let downloaded;
  URL.createObjectURL = blob => { downloaded = blob; return createUrl.call(URL, blob); };
  try { button("Export CSV").click(); await wait(() => downloaded, "CSV download"); }
  finally { URL.createObjectURL = createUrl; }
  const exported = await downloaded.text();
  check(exported.includes('"000102"') && !exported.includes('"000101"') && exported.includes('"-20"'), "Filtered CSV preserves order ID and numeric payout difference");
  set(document.querySelector('input[type="search"]'), "");
  const show = [...document.querySelectorAll("label")].find(label => label.textContent.startsWith("Show")).querySelector("select");
  set(show, "awaiting_statement");
  await wait(() => document.querySelectorAll(".zomato-table tbody tr").length === 2, "status filter");
  check(true, "Status filter isolates awaiting statements"); set(show, "all");
  button("Connection").click();
  await wait(() => document.querySelector(".zomato-connection"), "connection form");
  const name = [...document.querySelectorAll("label")].find(label => label.textContent === "Restaurant name").querySelector("input");
  set(name, "QA Zomato restaurant"); await wait(() => !button("Save connection").disabled, "connection edit"); button("Save connection").click();
  await wait(() => document.body.textContent.includes("Connection details saved"), "connection save");
  check((await api("/api/zomato/settings")).restaurantName === "QA Zomato restaurant", "Connection settings persist through the API");
  check(!document.querySelector('.zomato-connection input[type="checkbox"]'), "Live activation cannot be toggled without a provider");
  button("Live orders (1)").click();
  await wait(() => document.querySelector(".zomato-order"), "live screen");
  check(document.querySelector(".zomato-order").textContent.includes("Imported record"), "Imported open order is labelled accurately");
  check(document.body.textContent.includes("not active in this build"), "Live screen explains the activation requirement");
  button("Reconciliation").click();
  await wait(() => document.querySelector(".zomato-import"), "import form");
  const inputCsv = async (kind, csv) => {
    const root = document.querySelector(".zomato-import");
    set(root.querySelector("select"), kind);
    await new Promise(resolve => setTimeout(resolve, 60));
    const details = root.querySelector("details"); if (!details.open) details.querySelector("summary").click();
    set(root.querySelector("textarea"), csv);
    await wait(() => !button("Preview import").disabled, "preview enabled");
    button("Preview import").click();
  };
  const now = new Date(), day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const ordersCsv = `restaurant_id,order_id,ordered_at,status,order_total,payment_mode\n123456,000106,${now.toISOString()},delivered,180.00,prepaid`;
  await inputCsv("orders", ordersCsv);
  await wait(() => button("Import 1 records"), "order preview");
  check(document.querySelector(".zomato-preview").textContent.includes("₹180.00"), "Import preview shows the parsed amount before writing");
  button("Import 1 records").click();
  await wait(() => document.querySelector(".zomato-import").textContent.includes("Import complete: 1 added"), "order import");
  await wait(() => !button("Refresh").disabled, "refresh after import");
  check(!document.querySelector(".zomato-table tbody").textContent.includes("Missing order"), "Importing the missing order resolves its reconciliation");
  await inputCsv("orders", ordersCsv); await wait(() => button("Import 0 records"), "duplicate preview");
  check(button("Import 0 records").disabled && document.querySelector(".zomato-preview").textContent.includes("1 duplicates"), "Duplicate imports are skipped and cannot add again");
  const settlementCsv = `restaurant_id,order_id,entry_id,settlement_reference,settlement_date,gross_amount,deductions,additions,net_paid\n123456,000102,E7,ADJUSTMENT-1,${day},0,20,0,0`;
  await inputCsv("settlements", settlementCsv); await wait(() => button("Import 1 records"), "adjustment preview"); button("Import 1 records").click();
  await wait(() => document.querySelector(".zomato-import").textContent.includes("Import complete: 1 added"), "adjustment import");
  await wait(() => !button("Refresh").disabled, "updated reconciliation");
  const orderRow = [...document.querySelectorAll(".zomato-table tbody tr")].find(row => row.textContent.includes("#000102"));
  check(orderRow.textContent.includes("Matched") && orderRow.textContent.includes("ADJUSTMENT-1"), "Incremental settlement adjustment resolves the payout difference");
  await inputCsv("settlements", settlementCsv.replace("123456", "OTHER-RESTAURANT"));
  await wait(() => document.querySelector('.zomato-import [role="alert"]'), "invalid import alert");
  check(document.querySelector('.zomato-import [role="alert"]').textContent.includes("Restaurant ID"), "Wrong-restaurant import fails visibly");
  const dates = [...document.querySelectorAll('.zomato-toolbar input[type="date"]')];
  const previousDates = dates.map(input => input.value);
  set(dates[0], "2020-01-01"); set(dates[1], "2020-01-02");
  await wait(() => document.querySelector(".zomato-empty")?.textContent.includes("No orders or statements"), "empty period");
  check(button("Export CSV").disabled, "Empty report has no misleading export");
  set(dates[0], previousDates[0]); set(dates[1], previousDates[1]);
  await wait(() => !button("Refresh").disabled && document.querySelectorAll(".zomato-table tbody tr").length === 6, "restore dates");
  const originalFetch = window.fetch;
  window.fetch = (...args) => String(args[0]).startsWith("/api/zomato/reconciliation") ? Promise.reject(new Error("Fixture network failure")) : originalFetch(...args);
  try {
    button("Refresh").click();
    await wait(() => [...document.querySelectorAll('[role="alert"]')].some(e => e.textContent.includes("Fixture network failure")), "refresh error");
    check(button("Export CSV").disabled, "Failed refresh marks data stale and disables export");
  } finally { window.fetch = originalFetch; }
  button("Refresh").click(); await wait(() => !button("Export CSV").disabled, "refresh recovery");
  check(true, "Refresh recovers after connection failure");
  check((await api("/api/zomato/imports")).imports.length === 4, "Import audit counts successful writes only");
  window.__zomatoResult = { status: "passed", checks }; return window.__zomatoResult;
})();
