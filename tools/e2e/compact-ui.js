// Run with agent-browser eval --stdin against disposable fixtures on :4136/:4137.
// UI actions only; read-only API inspection verifies persisted totals and print output.
(async () => {
  if (!/^http:\/\/127\.0\.0\.1:413[67]$/.test(location.origin)) throw new Error("Disposable compact UI fixture required");
  const pause = (ms = 80) => new Promise(resolve => setTimeout(resolve, ms));
  const visible = e => e && e.getClientRects().length && getComputedStyle(e).visibility !== "hidden";
  const wait = async (fn, label) => { for (let i = 0; i < 150; i++) { const value = fn(); if (value) return value; await pause(); } throw new Error("Timed out: " + label); };
  const scope = () => document.querySelector("dialog[open]") || document;
  const button = text => [...scope().querySelectorAll("button")].find(e => visible(e) && !e.disabled && (e.textContent.trim() === text || e.getAttribute("aria-label") === text));
  const click = async text => { (await wait(() => button(text), text)).click(); await pause(); };
  const fill = (input, value) => { Object.getOwnPropertyDescriptor(input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, "value").set.call(input, value); input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); };
  const check = (value, label) => { if (!value) throw new Error(label); return label; };
  const measurements = () => {
    const names = [".menu-results", ".cart-items", ".billing-dialog-body", ".order-screen"];
    return Object.fromEntries(names.map(name => { const e = document.querySelector(name); return [name, e && visible(e) ? { client: e.clientHeight, scroll: e.scrollHeight, overflow: e.scrollHeight > e.clientHeight + 1 } : null]; }));
  };
  const after = location.port === "4137";
  const key = "forkflow.qa.compact";
  const saved = JSON.parse(localStorage.getItem(key) || "null");
  if (!saved) {
    if (button("Takeaway")) await click("Takeaway");
    await wait(() => document.querySelector(".menu-card"), "menu tiles");
    const select = document.querySelector('select[aria-label="Menu category"]');
    if (select) { fill(select, "all"); await pause(); } else await click("All items");
    const names = ["Paneer tikka", "Crispy corn", "Dal tadka", "Jeera rice", "Butter naan", "Masala tea", "Gulab jamun", "Sweet lassi"];
    for (const name of names) {
      const tile = [...document.querySelectorAll(".menu-card")].find(e => e.querySelector(".menu-card-name")?.textContent.trim() === name);
      check(tile, "Missing " + name); tile.click(); await pause();
    }
    check(document.querySelectorAll(after ? ".draft-row" : ".cart-section:first-child .cart-row").length === 8, "Eight cart rows");
    localStorage.setItem(key, JSON.stringify({ phase: "cart", measurements: measurements() }));
    return { phase: "cart", after, viewport: [innerWidth, innerHeight], measurements: measurements(), tileCount: document.querySelectorAll(".menu-card").length };
  }
  if (saved.phase === "cart") {
    await click(after ? "Discount · F4" : "Bill options");
    const printer = await wait(() => scope().querySelector("select"), "printer selector");
    const option = [...printer.options].find(e => e.textContent === "Counter receipt");
    fill(printer, option.value); await pause();
    const discount = [...scope().querySelectorAll("label")].find(e => e.textContent.includes("Discount ("))?.querySelector("input");
    const reason = [...scope().querySelectorAll("label")].find(e => e.textContent.includes("Discount reason"))?.querySelector("input");
    fill(discount, "25"); fill(reason, "Fixture discount"); await pause();
    await click("Close billing");
    await click(after ? "Pay · F10" : "Checkout");
    await wait(() => scope().querySelector(".quick-payment"), "checkout preview");
    localStorage.setItem(key, JSON.stringify({ ...saved, phase: "preview", preview: scope().querySelector(".bill-summary").textContent, paymentMeasurements: measurements() }));
    return { phase: "preview", summary: scope().querySelector(".bill-summary").textContent, measurements: measurements() };
  }
  if (saved.phase === "preview") {
    await click(after ? "Pay & print · F10" : "Issue bill & record cash payment");
    await wait(() => scope().querySelector(".billing-paid"), "recorded payment");
    await wait(() => scope().querySelector(".billing-print-status")?.textContent.includes("done"), "receipt printed");
    const headers = { authorization: "Bearer " + localStorage.getItem("forkflow.token") };
    const bills = await fetch("/api/bills?status=paid", { headers }).then(r => r.json());
    const bill = bills.bills.find(b => b.discountNote === "Fixture discount");
    check(bill, "Paid bill persisted");
    const prints = await fetch("/__qa/prints").then(r => r.json());
    const result = { ...saved, phase: "complete", bill, printed: prints.prints.map(p => p.text), measurements: measurements() };
    localStorage.setItem(key, JSON.stringify(result));
    return result;
  }
  return saved;
})();
