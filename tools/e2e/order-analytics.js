// Run via agent-browser eval --stdin, signed in to the disposable analytics fixture.
(async () => {
  if (location.origin !== "http://127.0.0.1:4163") throw new Error("Disposable analytics fixture only");
  const checks = [], downloads = [];
  const check = (ok, name) => { if (!ok) throw new Error(name); checks.push(name); };
  const wait = async (predicate) => { for (let n = 0; n < 200; n++) { if (predicate()) return; await new Promise((r) => setTimeout(r, 30)); } throw new Error("UI wait timed out"); };
  const root = () => document.querySelector(".order-analytics");
  const button = (text, scope = document) => [...scope.querySelectorAll("button")].find((e) => e.textContent.trim() === text);
  const click = async (text, scope = document) => { const e = button(text, scope); if (!e || e.disabled) throw new Error("Missing enabled button: " + text); e.click(); await new Promise((r) => setTimeout(r, 30)); };
  const loaded = () => root() && button("Export analytics CSV", root()) && !button("Export analytics CSV", root()).disabled;
  const nativeFetch = window.fetch, nativeCreate = URL.createObjectURL, nativeClick = HTMLAnchorElement.prototype.click;
  const api = async (query = "") => {
    const res = await nativeFetch("/api/reports/analytics" + query, { headers: { authorization: "Bearer " + localStorage.getItem("forkflow.token"), "x-forkflow-device": localStorage.getItem("forkflow.device.v1") } });
    if (!res.ok) throw new Error("Fixture API " + res.status); return (await res.json()).report;
  };
  const money = (n) => "₹" + (n / 100).toFixed(2);
  const metrics = () => [...root().querySelectorAll(".sales-metric > strong")].map((e) => e.textContent);
  const dates = () => [...root().querySelectorAll('input[type="date"]')].map((e) => e.value);
  let pendingBlob;
  URL.createObjectURL = (blob) => { pendingBlob = blob; return nativeCreate(blob); };
  HTMLAnchorElement.prototype.click = function() {
    if (this.download) { const entry = { filename: this.download, text: "" }; downloads.push(entry); void pendingBlob.text().then((text) => entry.text = text); }
    return nativeClick.call(this);
  };
  try {
    if (!root()) { if (!button("Analytics")) await click("Reports & Analytics"); await click("Analytics"); }
    await wait(loaded);
    check(document.querySelector('.sales-reports h2').textContent === "Reports & Analytics", "Page heading identifies Reports & Analytics");
    check(document.querySelector('[aria-label="Reports and analytics"]').querySelectorAll("button").length === 2, "Top switch offers Reports and Analytics");
    check(!document.querySelector('[aria-label="Report type"], [aria-label="Detailed report"]'), "Analytics view hides report-only choices");
    const all = await api();
    check(JSON.stringify(metrics()) === JSON.stringify([String(all.totals.orderCount), money(all.totals.totalPaise), String(all.totals.qty), money(Math.round(all.totals.totalPaise / all.totals.orderCount))]), "All metrics reconcile with stored bill data");
    check(all.comparison.every((row) => root().querySelector(".analytics-comparison").textContent.includes(money(row.totalPaise))), "Both service comparisons show exact issued sales");
    check(root().querySelectorAll(".analytics-items tbody tr").length === 10, "Highest moving items initially shows top 10");
    await click("Show all 12 items");
    check(root().querySelectorAll(".analytics-items tbody tr").length === 12, "Show all reveals every billed item");
    await click("Sales", root().querySelector(".analytics-items"));
    const topSales = [...all.items].sort((a, b) => b.totalPaise - a.totalPaise || b.qty - a.qty)[0];
    check(root().querySelector(".analytics-items tbody tr").textContent.includes(topSales.name), "Sales ranking shows the highest revenue item first");
    await click("Quantity", root().querySelector(".analytics-items"));
    check(root().querySelector(".analytics-items tbody tr").textContent.includes(all.items[0].name), "Quantity ranking shows the highest moving item first");
    const trend = root().querySelector(".analytics-trend figure"); trend.focus(); trend.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    await wait(() => trend.querySelector("figcaption").textContent.includes(all.from));
    check(trend.querySelector("figcaption").textContent.includes(money(all.daily[0].totalPaise)), "Keyboard trend selection exposes exact first-day sales");
    trend.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    await wait(() => trend.querySelector("figcaption").textContent.includes(all.to)); check(true, "End key selects the last report date");
    const hours = root().querySelectorAll(".analytics-hour"); check(hours.length === 24, "Busy hours supplies all 24 accessible buttons");
    hours[11].click(); await new Promise((r) => setTimeout(r, 30));
    check(hours[11].getAttribute("aria-pressed") === "true" && root().querySelector('[aria-label="Busy hours"] p').textContent.includes(money(all.hourly[11].totalPaise)), "Selecting an hour shows its exact order count and sales");
    const comparison = root().querySelector(".analytics-comparison tbody").textContent;
    for (const [label, type] of [["Quick takeaway", "parcel"], ["Table orders", "dine_in"]]) {
      await click(label, root().querySelector(".analytics-filter")); await wait(loaded);
      const filtered = await api(`?type=${type}`);
      check(metrics()[0] === String(filtered.totals.orderCount) && metrics()[1] === money(filtered.totals.totalPaise), `${label} filter reconciles totals`);
      check(root().querySelector(".analytics-comparison tbody").textContent === comparison, `${label} filter preserves both comparison rows`);
      const opposite = type === "parcel" ? 3 : 2;
      check([...root().querySelectorAll(".analytics-items tbody tr")].every((row) => row.children[opposite].textContent === "0"), `${label} item quantities exclude the other service type`);
    }
    await click("Export analytics CSV"); await wait(() => downloads.length && downloads[0].text);
    check(downloads[0].filename.includes("analytics-dine_in") && downloads[0].text.includes("Breakdown filter: Table orders") && downloads[0].text.includes("Busy hours"), "CSV captures the displayed filter and every analytics section");
    await click("All orders", root().querySelector(".analytics-filter")); await wait(loaded);
    await click("Today", root()); await wait(loaded);
    const today = await api(`?from=${all.today}&to=${all.today}`);
    check(metrics()[0] === String(today.totals.orderCount) && dates().every((date) => date === all.today), "Today preset applies to all analytics sections");
    await click("Reports", document.querySelector('[aria-label="Reports and analytics"]'));
    await click("Sales", document.querySelector('[aria-label="Report type"]'));
    await wait(() => document.querySelector('.sales-report-table[aria-label="Sales daily data"]'));
    check([...document.querySelectorAll('input[type="date"]')].every((e) => e.value === all.today), "Analytics date range is retained in Sales");
    await click("Collections", document.querySelector('[aria-label="Report type"]'));
    await wait(() => document.querySelector('.sales-report-table[aria-label="Collections daily data"]'));
    await click("Analytics"); await wait(loaded);
    await click("Reports", document.querySelector('[aria-label="Reports and analytics"]'));
    await wait(() => document.querySelector('.sales-report-table[aria-label="Collections daily data"]'));
    check(button("Collections", document.querySelector('[aria-label="Report type"]')).getAttribute("aria-pressed") === "true", "Top switch remembers the selected report");
    await click("Analytics"); await wait(loaded);
    check(dates().every((date) => date === all.today), "Returning to Analytics retains the report date range");
    await click("30 days", root()); await wait(loaded);
    check(new Date(dates()[1]) - new Date(dates()[0]) === 29 * 86400000, "30-day preset updates the date range");
    const inputs = root().querySelectorAll('input[type="date"]');
    const setValue = (e, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(e, value); e.dispatchEvent(new Event("input", { bubbles: true })); };
    setValue(inputs[0], "2020-01-01"); setValue(inputs[1], "2020-01-01"); await new Promise((r) => setTimeout(r, 30));
    await click("Apply dates", root()); await wait(loaded);
    check(JSON.stringify(metrics()) === JSON.stringify(["0", "₹0.00", "0", "₹0.00"]) && root().textContent.includes("No billed orders"), "Empty date range shows zero metrics and helpful empty state");
    await click("7 days", root()); await wait(loaded);
    window.fetch = async (input, init) => String(input).startsWith("/api/reports/analytics") ? new Response(JSON.stringify({ error: "Analytics unavailable" }), { status: 503, headers: { "content-type": "application/json" } }) : nativeFetch(input, init);
    await click("Refresh", root()); await wait(() => root().querySelector('[role="alert"]'));
    check(!root().querySelector(".analytics-metrics") && button("Export analytics CSV", root()).disabled, "Fetch failure hides stale totals and disables export");
    window.fetch = nativeFetch; await click("Refresh", root()); await wait(loaded);
    check(metrics()[0] === String(all.totals.orderCount), "Refresh recovers analytics after a failed request");
    let release;
    window.fetch = (input, init) => String(input).includes("/api/reports/analytics?") && String(input).includes("type=parcel")
      ? new Promise((resolve) => { release = async () => resolve(await nativeFetch(input, { ...init, signal: undefined })); }) : nativeFetch(input, init);
    await click("Quick takeaway", root().querySelector(".analytics-filter")); await wait(() => release);
    await click("Table orders", root().querySelector(".analytics-filter")); await wait(loaded);
    const beforeLateResponse = metrics().join("|"); await release(); await new Promise((r) => setTimeout(r, 100));
    check(metrics().join("|") === beforeLateResponse && button("Table orders", root().querySelector(".analytics-filter")).getAttribute("aria-pressed") === "true", "Late response cannot overwrite a newer filter");
    window.fetch = nativeFetch; await click("All orders", root().querySelector(".analytics-filter")); await wait(loaded);
    check(!document.querySelector("vite-error-overlay, [data-nextjs-dialog]"), "No framework error overlay");
    return JSON.stringify({ status: "passed", count: checks.length, checks });
  } finally { window.fetch = nativeFetch; URL.createObjectURL = nativeCreate; HTMLAnchorElement.prototype.click = nativeClick; }
})();
