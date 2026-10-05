// Run through agent-browser eval --stdin after signing into the disposable fixture as admin.
(async () => {
  const checks = [];
  const assert = (condition, message) => { if (!condition) throw new Error(message); checks.push(message); };
  const wait = async (check) => { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise((r) => setTimeout(r, 50)); } throw new Error("UI wait timed out"); };
  const button = (text) => [...document.querySelectorAll("button")].find((e) => e.textContent.trim() === text);
  const setValue = (element, value) => {
    const prototype = element.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
    element.dispatchEvent(new Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  };
  const originalFetch = window.fetch, originalCreate = URL.createObjectURL;
  const downloads = [];
  URL.createObjectURL = (blob) => { downloads.push(blob); return originalCreate(blob); };
  try {
    button("Reports & Analytics").click();
    await wait(() => document.querySelector('[aria-label="Detailed report"]'));
    for (const kind of ["items", "cashiers", "hourly", "kots", "cancellations", "stock"]) {
      setValue(document.querySelector('[aria-label="Detailed report"]'), kind);
      await wait(() => button("Export CSV") && !button("Export CSV").disabled && document.querySelector(".operational-report table"));
      const dates = [...document.querySelectorAll('.operational-report input[type="date"]')].map((e) => e.value);
      const response = await originalFetch(`/api/reports/operations/${kind}?from=${dates[0]}&to=${dates[1]}`, { headers: { authorization: `Bearer ${localStorage.getItem("forkflow.token")}` } });
      const { report } = await response.json();
      assert(response.ok, `${kind}: API loaded`);
      const regions = [...document.querySelectorAll('.operational-report [role="region"]')];
      assert(regions.length === report.tables.filter((t) => t.rows.length).length, `${kind}: all report sections render`);
      for (const table of report.tables.filter((t) => t.rows.length)) {
        const region = regions.find((e) => e.getAttribute("aria-label") === table.title);
        assert(region.querySelectorAll("tbody tr").length === table.rows.length, `${kind}: ${table.title} row count matches API`);
      }
      const before = downloads.length; button("Export CSV").click();
      await wait(() => downloads.length > before);
      const csv = await downloads.at(-1).text();
      assert(csv.includes(`"Report","${kind}"`) && csv.includes(report.from) && csv.includes(report.timezone), `${kind}: CSV contains report/date/timezone`);
      assert(report.tables.every((t) => csv.includes(t.title)), `${kind}: CSV includes all tables`);
      if (kind === "items") assert(csv.includes('"880.00"'), "Item sales CSV reconciles with fixture bills");
      if (kind === "cashiers") assert(regions[0].textContent.includes("Counter 2"), "Collections show settling cashier");
      if (kind === "hourly") assert(report.tables[0].rows.length === 24, "Hourly report has 24 hours");
      if (kind === "kots") assert(report.tables[0].rows[0].average === 12, "KOT average excludes pending and cancelled tickets");
      if (kind === "stock") assert(report.tables[0].rows[0].closing === 19.375, "Stock closes after consumption, reversal and wastage");
    }
    // Clear old data immediately on a failed refresh; exports must be disabled.
    window.fetch = (url, options) => String(url).includes("/api/reports/operations/")
      ? Promise.resolve(new Response(JSON.stringify({ error: "Report unavailable test" }), { status: 503, headers: { "content-type": "application/json" } }))
      : originalFetch(url, options);
    button("Refresh").click();
    await wait(() => document.querySelector('[role="alert"]')?.textContent.includes("Report unavailable test"));
    assert(!document.querySelector(".operational-report table") && button("Export CSV").disabled, "Failed refresh clears stale report and disables export");
    window.fetch = originalFetch;
    button("Refresh").click();
    await wait(() => !button("Export CSV").disabled);
    // A range with no records remains usable and exportable.
    setValue(document.querySelector('[aria-label="Detailed report"]'), "items");
    await wait(() => document.querySelector('.operational-report h3')?.textContent === "Item / category sales" && !button("Export CSV").disabled);
    const fields = [...document.querySelectorAll('.operational-report input[type="date"]')];
    setValue(fields[0], "2020-01-01"); setValue(fields[1], "2020-01-02"); button("Apply dates").click();
    await wait(() => document.querySelector(".operational-report")?.textContent.includes("No records for these dates."));
    assert(!button("Export CSV").disabled, "Empty date range has an exportable report");
    button("Today").click(); await wait(() => !button("Export CSV").disabled && document.querySelector(".operational-report table"));
    const selectedDates = [...document.querySelectorAll('.operational-report input[type="date"]')].map((e) => e.value);
    setValue(document.querySelector('[aria-label="Detailed report"]'), "cashiers");
    await wait(() => document.querySelector('.operational-report h3')?.textContent === "Cashier collections" && !button("Export CSV").disabled);
    assert(JSON.stringify([...document.querySelectorAll('.operational-report input[type="date"]')].map((e) => e.value)) === JSON.stringify(selectedDates), "Detailed reports preserve the selected date range when switching");
    const result = { status: "passed", count: checks.length, checks };
    window.__operationalReportResult = result;
    return result;
  } finally { window.fetch = originalFetch; URL.createObjectURL = originalCreate; }
})()
