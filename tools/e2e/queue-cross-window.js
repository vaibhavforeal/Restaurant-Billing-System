// Run via browser eval on the disposable Captain fixture, desktop / signed in.
// Opens a real second application window and pauses each producer generation check.
// The second window performs every queued POST; the producer must unlock once.
(async () => {
  if (location.origin !== "http://127.0.0.1:4139" || location.pathname !== "/") throw new Error("Disposable Captain desktop fixture required");
  const checks = [], posts = [], nativeFetch = window.fetch.bind(window);
  const pause = () => new Promise(resolve => setTimeout(resolve, 40));
  const wait = async (fn, label) => {
    const until = Date.now() + 18000;
    while (Date.now() < until) { const value = await fn(); if (value) return value; await pause(); }
    throw new Error(`Timed out: ${label}. ${document.body.innerText.slice(-900)}`);
  };
  const check = (ok, label) => { if (!ok) throw new Error(label); checks.push(label); };
  const headers = { authorization: `Bearer ${localStorage.getItem("forkflow.token")}`, "x-forkflow-device": localStorage.getItem("forkflow.device.v1") };
  const api = async path => { const response = await nativeFetch(path, { headers }); if (!response.ok) throw new Error(`${path}: ${response.status}`); return response.json(); };
  const button = label => [...document.querySelectorAll("button")].find(b => b.textContent.trim().replace(/\s*·\s*F\d+\s*$/, "") === label);
  const click = async label => (await wait(() => { const b = button(label); return b && !b.disabled && b; }, label)).click();
  const pending = () => Object.keys(localStorage).filter(key => key.startsWith("forkflow.queue.v1.")).map(key => JSON.parse(localStorage.getItem(key)));
  const completions = id => Object.keys(localStorage).filter(key => key.startsWith(`forkflow.queue-result.v1.${id}.`)).map(key => JSON.parse(localStorage.getItem(key)));
  const second = window.open("/", "forkflow-queue-worker", "width=1100,height=800");
  if (!second) throw new Error("Allow a popup for the disposable two-window gate");
  let undoSecond = () => {}, gateA, gateB;
  function intercept(win, name) {
    const original = win.fetch.bind(win);
    const gate = { armed: false, reached: false, release: null };
    win.fetch = async (url, init) => {
      if (String(url) === "/api/system/generation" && gate.armed) {
        gate.reached = true;
        await new Promise(resolve => { gate.release = resolve; });
        gate.armed = false; gate.reached = false; gate.release = null;
      }
      if (init?.method === "POST" && /\/(items|send|bill|settle)$/.test(String(url))) posts.push({ window: name, path: String(url), body: init.body });
      return original(url, init);
    };
    return { gate, undo: () => { gate.release?.(); win.fetch = original; } };
  }
  const producer = intercept(window, "A"); gateA = producer.gate;
  try {
    await wait(() => second.document?.querySelector(".pos-statusbar"), "second app window authenticated");
    const worker = intercept(second, "B"); gateB = worker.gate; undoSecond = worker.undo;
    check(pending().length === 0, "Fixture begins with no pending operations");
    if (document.querySelector(".order-screen")) await click("← Tables");
    else if (!document.querySelector(".table-card")) await click("tables");
    const free = (await api("/api/tables")).tables.find(table => table.status === "free");
    if (!free) throw new Error("An unused fixture table is required");
    (await wait(() => [...document.querySelectorAll(".table-card")].find(card => card.querySelector("strong")?.textContent === free.name), "free table")).click();
    await wait(() => document.querySelector(".order-screen"), "order workspace"); await click("All items");
    (await wait(() => [...document.querySelectorAll(".menu-card")].find(card => card.querySelector(".menu-card-name")?.textContent.trim() === "Paneer tikka" && !card.disabled), "fixture kitchen item")).click();
    const orderAtTable = async () => (await api("/api/orders")).orders.find(order => order.tableId === free.id || order.tableName === free.name);
    const initial = await orderAtTable();
    async function completeInWorker(label, suffix, done) {
      gateA.armed = gateB.armed = true;
      await wait(() => gateA.reached && gateB.reached, "both generation checks paused");
      await click(label);
      const request = await wait(() => pending().find(entry => entry.path.endsWith(suffix)), `${label} persisted before POST`);
      gateB.release();
      await wait(() => completions(request.id).some(record => record.outcome === "success") && !pending().some(entry => entry.id === request.id), `${label} worker durable completion`);
      await wait(done, `${label} producer unlocked`);
      gateA.release(); await wait(() => !gateA.armed && !gateB.armed, "generation checks resumed"); await pause();
      check(posts.filter(post => post.path === request.path && post.body === request.body).length === 1 && posts.find(post => post.path === request.path && post.body === request.body)?.window === "B", `${label} posted once by window B`);
      check(completions(request.id).length === 1, `${label} has immutable durable response`);
    }
    await completeInWorker("Punch", "/items", () => document.querySelectorAll(".draft-row").length === 0 && !document.querySelector('[data-shortcut="send_kitchen"]')?.disabled);
    check((await orderAtTable()).items.length === initial.items.length + 1, "Exactly one database item after cross-window punch");
    await completeInWorker("KOT", "/send", () => document.querySelector(".captain-message")?.textContent.includes("Sent to kitchen") && document.querySelector('[data-shortcut="send_kitchen"]')?.disabled);
    const sent = await orderAtTable(); check(sent.kots.length === initial.kots.length + 1, "Exactly one database KOT after cross-window send");
    await click("Preview bill"); await wait(() => button("Issue bill"), "bill preview");
    await completeInWorker("Issue bill", "/bill", () => button("Settle bill") && !button("Settle bill").disabled);
    const issued = (await api(`/api/orders/${sent.id}/bill`)).bill; check(!!issued && issued.status === "unpaid", "One persisted unpaid bill and unlocked billing");
    await completeInWorker("Settle bill", "/settle", () => document.querySelector(".billing-message")?.textContent.includes("Payment recorded") && !button("Close")?.disabled);
    const paid = (await api(`/api/orders/${sent.id}/bill`)).bill;
    check(paid.id === issued.id && paid.status === "paid", "Same bill settled without duplicate checkout");
    check(paid.payments.length === 1 && paid.payments[0].amountPaise === paid.totalPaise, "Exactly one database payment for the settled bill");
    check(posts.filter(post => post.path.endsWith("/settle")).length === 1 && posts.filter(post => post.path.endsWith("/send")).length === 1, "No extra settlement or KOT continuation requests");
    check(!pending().length && !document.querySelector(".pos-status-warning"), "Producer finishes connected with unlocked UI");
    return { status: "passed", checks, orderId: sent.id, billId: paid.id, posts };
  } finally { producer.undo(); undoSecond(); second.close(); }
})();
