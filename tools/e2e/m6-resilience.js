// Run with agent-browser eval --stdin, on a scratch server signed in as admin.
(async () => {
  if (!/^https?:\/\/(localhost|127\.0\.0\.1):/.test(location.origin)) throw new Error("Local scratch server required");
  const checks = [];
  const check = (ok, message) => { if (!ok) throw new Error(message); checks.push(message); };
  const waitFor = async (fn, label) => {
    const end = Date.now() + 12000;
    while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise((r) => setTimeout(r, 80)); }
    throw new Error(`Timed out: ${label}. ${document.body.innerText.slice(-1400)}`);
  };
  const button = (text) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
  const click = async (text) => { const b = await waitFor(() => { const candidate = button(text); return candidate && !candidate.disabled ? candidate : null; }, `enabled ${text}`); b.click(); await new Promise((r) => setTimeout(r, 100)); };
  const nativeFetch = window.fetch.bind(window);
  const api = async (path, method = "GET", body) => {
    const res = await nativeFetch(`/api${path}`, { method, headers: { authorization: `Bearer ${localStorage.getItem("forkflow.token")}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await res.json(); if (!res.ok) throw new Error(`${path}: ${JSON.stringify(data)}`); return data;
  };
  await waitFor(() => localStorage.getItem("forkflow.generation"), "server generation checked");
  await click("settings"); await waitFor(() => button("Back up now"), "backup controls");
  const count = (await api("/system/backups")).backups.length;
  await click("Back up now"); await waitFor(() => document.body.innerText.includes("Verified local backup saved"), "manual backup");
  const backups = await api("/system/backups");
  check(backups.backups.length === count + 1, "Manual backup created from Settings");
  const copy = await nativeFetch(`/api/system/backups/${backups.backups[0].name}`, { headers: { authorization: `Bearer ${localStorage.getItem("forkflow.token")}` } });
  check(new TextDecoder().decode((await copy.arrayBuffer()).slice(0, 15)) === "SQLite format 3", "Backup download contains a SQLite snapshot");
  const connections = await api("/system/connections");
  if (connections.connections.length) {
    check([...document.querySelectorAll("img")].some((img) => img.alt.includes("Connect to ForkFlow") && img.complete && img.naturalWidth > 0), "LAN QR code renders locally");
    const shortcut = await nativeFetch(`/api/system/shortcut?url=${encodeURIComponent(connections.connections[0].url)}`, { headers: { authorization: `Bearer ${localStorage.getItem("forkflow.token")}` } });
    check((await shortcut.text()).includes(`--app=${connections.connections[0].url}`), "Edge shortcut targets the displayed LAN address");
  }
  const stamp = Date.now();
  const { category } = await api("/categories", "POST", { name: `Resilience ${stamp}` });
  const { stations } = await api("/kot-stations");
  const { product } = await api("/products", "POST", { categoryId: category.id, name: `Retry meal ${stamp}`, pricePaise: 10000, gstRate: 5, kotStationId: stations[0].id });
  await click("tables"); await click("New parcel"); await waitFor(() => button("Preview bill"), "order");
  if (!button(category.name)?.disabled) await click(category.name);
  const productButton = () => [...document.querySelectorAll("button")].find((b) => b.textContent.includes(product.name));
  (await waitFor(productButton, "menu product")).click();
  await waitFor(() => button("Punch"), "saved draft");
  const draftKey = Object.keys(localStorage).find((key) => key.startsWith("forkflow.draft.") && localStorage.getItem(key).includes(product.id));
  check(!!draftKey, "Cart persisted before any request");
  const orderId = draftKey.split(".").at(-1);
  const { order } = await api(`/orders/${orderId}`);
  await click("home"); await click("tables"); await click(`Parcel ${order.clientRef.slice(0, 8)}`);
  await waitFor(() => button("Punch"), "restored cart");
  check(document.body.innerText.includes("Cart (1 items)"), "Draft survives leaving and reopening the order");
  if (!button(category.name)?.disabled) await click(category.name);
  let offline = true, losePath = "", lost = false;
  window.fetch = async (path, init) => {
    if (offline && String(path).startsWith("/api/")) throw new TypeError("Simulated connection loss");
    const response = await nativeFetch(path, init);
    if (!lost && String(path) === losePath && init?.method === "POST") { lost = true; throw new TypeError("Simulated lost acknowledgement"); }
    return response;
  };
  try {
    await click("Punch");
    await waitFor(() => document.body.innerText.includes("Saved; will send when connected"), "queued punch");
    check((await api(`/orders/${orderId}`)).order.items.length === 0, "Offline punch is saved without reaching the server");
    // New rows remain editable while the original frozen row is queued.
    productButton().click();
    await waitFor(() => document.body.innerText.includes("Cart (2 items)"), "editable offline cart");
    offline = false;
    await waitFor(async () => (await api(`/orders/${orderId}`)).order.items.length === 1, "punch reconnect");
    await waitFor(() => document.body.innerText.includes("Cart (1 items)"), "only acknowledged row removed");
    check(JSON.parse(localStorage.getItem(draftKey)).length === 1, "Punch acknowledgement preserves newer cart rows");
    await click("Punch"); await waitFor(() => !button("Punch"), "second punch");
    losePath = `/api/orders/${orderId}/send`; lost = false;
    await click("Send to kitchen");
    await waitFor(() => lost && !Object.keys(localStorage).some((key) => key.startsWith("forkflow.queue.v1.")), "kitchen acknowledgement replay");
    const sent = (await api(`/orders/${orderId}`)).order;
    check(sent.items.length === 2 && sent.items.every((i) => i.status === "sent"), "Kitchen retry keeps one saved send request");
    check((await api("/kots")).kots.filter((k) => k.orderId === orderId).length === 1, "Lost kitchen acknowledgement does not duplicate KOTs");
    await click("Preview bill"); await waitFor(() => button("Issue bill"), "bill preview");
    losePath = `/api/orders/${orderId}/bill`; lost = false;
    await click("Issue bill");
    await waitFor(() => button("Settle bill"), "bill issued after response loss");
    await waitFor(() => !Object.keys(localStorage).some((key) => key.startsWith("forkflow.queue.v1.")), "bill queue cleared");
    const { bill } = await api(`/orders/${orderId}/bill`);
    check(bill.status === "unpaid", "Bill issue resolves a lost acknowledgement from the same saved request");
    losePath = `/api/bills/${bill.id}/settle`; lost = false;
    await click("Settle bill");
    await waitFor(() => lost && !Object.keys(localStorage).some((key) => key.startsWith("forkflow.queue.v1.")), "settlement replay");
    const paid = (await api(`/orders/${orderId}/bill`)).bill;
    check(paid.status === "paid" && paid.payments.length === 1, "Lost settlement acknowledgement records payment only once");
  } finally { window.fetch = nativeFetch; }
  await click("settings");
  return { passed: checks.length, checks };
})()
