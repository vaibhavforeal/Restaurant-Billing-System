// Run on the disposable Captain fixture (:4139), signed in on / as admin/cashier.
(async () => {
  if (location.origin !== "http://127.0.0.1:4139" || location.pathname !== "/") throw new Error("Disposable desktop fixture required");
  const checks = [];
  const pause = () => new Promise(resolve => setTimeout(resolve, 60));
  const check = (ok, label) => { if (!ok) throw new Error(label); checks.push(label); };
  const wait = async (fn, label) => {
    const until = Date.now() + 12000;
    while (Date.now() < until) { const value = await fn(); if (value) return value; await pause(); }
    throw new Error("Timed out: " + label);
  };
  const nativeFetch = window.fetch.bind(window);
  const headers = { authorization: "Bearer " + localStorage.getItem("forkflow.token"), "x-forkflow-device": localStorage.getItem("forkflow.device.v1") };
  const api = async path => {
    const response = await nativeFetch(path, { headers });
    if (!response.ok) throw new Error(path + ": " + response.status);
    return response.json();
  };
  const button = name => [...document.querySelectorAll("button")].find(e => e.textContent.trim() === name);
  const click = async name => { (await wait(() => { const b = button(name); return b && !b.disabled && b; }, name)).click(); await pause(); };
  const kotButton = () => document.querySelector('[data-shortcut="F9"]');
  const queues = () => Object.keys(localStorage).filter(key => key.startsWith("forkflow.queue.v1.")).map(key => JSON.parse(localStorage.getItem(key)));
  const openTable = async name => {
    if (document.querySelector(".order-screen")) await click("← Tables");
    else if (!document.querySelector(".table-card")) await click("tables");
    (await wait(() => [...document.querySelectorAll(".table-card")].find(e => e.querySelector("strong")?.textContent === name), name)).click();
    await wait(() => kotButton(), "order workspace");
    await click("All items");
  };
  const add = async name => {
    (await wait(() => [...document.querySelectorAll(".menu-card")].find(e => e.querySelector(".menu-card-name")?.textContent.trim() === name && !e.disabled), name)).click();
    await pause();
  };
  let sends = [];
  window.fetch = async (url, init) => {
    if (String(url).endsWith("/send") && init?.method === "POST") sends.push(JSON.parse(init.body));
    return nativeFetch(url, init);
  };
  try {
    const { user } = await api("/api/me");
    const available = (await api("/api/tables")).tables.filter(t => t.status === "free");
    if (available.length < 2) throw new Error("Two unused fixture tables required");
    const firstTable = available[0].name, drinksTable = available[1].name;
    await openTable(firstTable);
    const orderAtTable = async name => (await api("/api/orders")).orders.find(o => o.tableName === name);
    const first = await orderAtTable(firstTable);
    const draftKey = `forkflow.draft.${user.id}.${first.id}`;
    check(kotButton().disabled, "Empty order disables KOT");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "F9", bubbles: true })); await pause();
    check(sends.length === 0 && queues().length === 0, "Empty F9 creates no request or saved-action error");
    await add("Paneer tikka"); await add("Fresh lime");
    const send = kotButton(); send.click(); send.click();
    await wait(() => document.querySelector(".captain-message")?.textContent.includes("Sent to kitchen"), "first KOT acknowledgement");
    const sent = await orderAtTable(firstTable);
    check(sent.items.length === 2 && sent.kots.length === 1, "KOT saves cart and creates exactly one ticket on double click");
    check(sent.items.find(i => i.name === "Paneer tikka")?.status === "sent" && sent.items.find(i => i.name === "Fresh lime")?.status === "pending", "Only kitchen-routed items are sent");
    check(JSON.parse(localStorage.getItem(draftKey)).length === 0 && queues().length === 0, "Acknowledged cart clears without a saved-action error");
    check(kotButton().disabled && sends.length === 1 && sends[0].itemIds.length === 1, "Already-sent items cannot generate an empty or duplicate KOT");
    await wait(async () => (await api("/__qa/prints")).prints.some(text => text.includes("Paneer tikka")), "captured KOT print");
    check(true, "Ticket reaches the fake printer");

    await add("Crispy corn"); await click("Punch");
    await wait(() => document.querySelectorAll(".draft-row").length === 0 && !kotButton().disabled, "punched row");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "F9", bubbles: true }));
    await wait(async () => (await orderAtTable(firstTable)).kots.length === 2 && !queues().length, "punched KOT");
    check(true, "Punch followed by F9 still sends a new kitchen round");

    await add("Veg kebab");
    let lost = false, retryBodies = [];
    window.fetch = async (url, init) => {
      if (String(url).endsWith("/send") && init?.method === "POST") {
        const body = JSON.parse(init.body); sends.push(body); retryBodies.push(init.body);
        const response = await nativeFetch(url, init);
        if (!lost && response.ok) { lost = true; throw new TypeError("Controlled lost KOT response"); }
        return response;
      }
      return nativeFetch(url, init);
    };
    kotButton().click();
    await wait(() => lost && !queues().length && document.querySelector(".captain-message")?.textContent.includes("Sent to kitchen"), "lost-response recovery");
    const recovered = await orderAtTable(firstTable);
    check(retryBodies.length >= 2 && new Set(retryBodies).size === 1 && recovered.kots.length === 3 && recovered.items.length === 4, "Lost response retries the same KOT without duplicate items or tickets");

    window.fetch = async (url, init) => {
      if (String(url).endsWith("/send") && init?.method === "POST") sends.push(JSON.parse(init.body));
      return nativeFetch(url, init);
    };
    await openTable(drinksTable); await add("Fresh lime");
    const before = sends.length;
    kotButton().click();
    await wait(() => document.querySelector(".captain-message")?.textContent.includes("No items are waiting"), "non-kitchen feedback");
    const drinks = await orderAtTable(drinksTable);
    check(drinks.items.length === 1 && drinks.kots.length === 0 && sends.length === before && queues().length === 0, "Non-kitchen cart saves with clear feedback and no empty send");
    check(sends.every(body => body.itemIds.length > 0), "Every KOT request has at least one item");
    check(!document.querySelector(".error-message")?.textContent && !document.querySelector(".pos-status-warning"), "Order returns to connected state without errors");
    return { status: "passed", checks };
  } finally { window.fetch = nativeFetch; }
})();
