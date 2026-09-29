// Run via agent-browser eval --stdin against a local scratch DB, signed in as admin.
(async () => {
  if (!/^https?:\/\/(localhost|127\.0\.0\.1):/.test(location.origin)) throw new Error('Local test server required');
  const checks = [];
  const check = (ok, message) => { if (!ok) throw new Error(message); checks.push(message); };
  const waitFor = async (fn, description) => {
    const end = Date.now() + 8000;
    while (Date.now() < end) { const result = fn(); if (result) return result; await new Promise((r) => setTimeout(r, 50)); }
    throw new Error(`Timed out: ${description}. ${document.body.innerText.slice(-1800)}`);
  };
  const button = (text) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
  const click = async (text) => { const b = await waitFor(() => button(text), text); if (b.disabled) throw new Error(`Disabled: ${text}`); b.click(); await new Promise((r) => setTimeout(r, 100)); };
  const field = (text) => [...document.querySelectorAll('label')].find((l) => l.textContent.trim().startsWith(text))?.querySelector('input,select');
  const fill = async (text, value) => {
    const input = await waitFor(() => field(text), text);
    Object.getOwnPropertyDescriptor(input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 70));
  };
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(`/api${path}`, { method, headers: { authorization: `Bearer ${localStorage.getItem('forkflow.token')}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json = await response.json(); if (!response.ok) throw new Error(`${path}: ${JSON.stringify(json)}`); return json;
  };
  const suffix = Date.now(); const name = `Gate ingredient ${suffix}`;
  const { category } = await api('/categories', 'POST', { name: `Inventory gate ${suffix}` });
  const { stations } = await api('/kot-stations');
  const { product: meal } = await api('/products', 'POST', { categoryId: category.id, name: `Gate meal ${suffix}`, pricePaise: 10000, gstRate: 5, kotStationId: stations.find((s) => s.isActive).id });
  const { product: parcel } = await api('/products', 'POST', { categoryId: category.id, name: `Gate parcel ${suffix}`, pricePaise: 10000, gstRate: 5, kotStationId: null });
  await click('inventory');
  await fill('Stock name', name); await fill('Unit', 'kg'); await fill('Opening quantity', '0.2'); await fill('Low-stock threshold', '0.1'); await click('Add stock item');
  await waitFor(() => button(`Manage ${name}`), 'created stock item');
  let stock = (await api('/stock-items')).items.find((s) => s.name === name);
  check(stock.qty === 0.2 && stock.unit === 'kg', 'Stock item created from the form with an opening balance');
  const current = async () => (await api('/stock-items')).items.find((s) => s.id === stock.id);
  async function link(product, amount) {
    await fill('Menu product', product.id); await waitFor(() => field('Tracked stock'), 'stock link loaded');
    await fill('Tracked stock', stock.id); await fill('Quantity per sale', amount); await click('Save stock link');
    await waitFor(() => document.body.innerText.includes('Stock link saved'), 'link saved');
  }
  await link(meal, '0.125'); await link(parcel, '0.1');
  check((await api(`/products/${meal.id}/stock-links`)).links[0].qtyPerSale === 0.125, 'Fractional product link saved');
  async function punch(product) {
    if (!button('tables')?.disabled) await click('tables');
    await click('New parcel'); await waitFor(() => button('Preview bill'), 'order screen');
    if (!button(category.name)?.disabled) await click(category.name);
    const productButton = await waitFor(() => [...document.querySelectorAll('button')].find((b) => b.textContent.includes(product.name)), 'product button');
    productButton.click(); await waitFor(() => button('Punch'), 'draft'); await click('Punch');
    await waitFor(() => !button('Punch'), 'punched');
    return (await api('/orders')).orders.find((o) => o.items.some((i) => i.productId === product.id));
  }
  const kitchenOrder = await punch(meal);
  check((await current()).qty === 0.2, 'Punching does not deduct stock');
  await click('Send to kitchen');
  await waitFor(() => document.body.innerText.includes('ordering is still available'), 'low-stock warning');
  check((await current()).qty === 0.075, 'Kitchen send deducts fractional stock');
  check(!button('Send to kitchen').disabled, 'Low stock does not block ordering controls');
  const originalPrompt = window.prompt; const originalConfirm = window.confirm;
  try {
    window.prompt = () => 'Customer cancellation'; window.confirm = () => true;
    await click('Cancel'); await waitFor(() => document.body.innerText.includes('Customer cancellation'), 'cancelled item');
    check((await current()).qty === 0.2, 'Sent cancellation restores the original quantity');
    await click('Cancel order');
  } finally { window.prompt = originalPrompt; window.confirm = originalConfirm; }
  await waitFor(() => button('New parcel'), 'tables');
  const parcelOrder = await punch(parcel);
  check((await current()).qty === 0.2, 'Stationless stock waits for billing');
  await click('Preview bill'); await waitFor(() => button('Issue bill'), 'preview'); await click('Issue bill');
  await waitFor(() => button('Settle bill'), 'bill issued');
  check((await current()).qty === 0.1, 'Stationless billing deducts stock exactly once');
  await click('Settle bill'); await waitFor(() => document.body.innerText.includes('Paid:'), 'settled');
  check((await current()).qty === 0.1, 'Settlement does not deduct stock again');
  await click('inventory'); await click(`Manage ${name}`);
  async function movement(reason, amount, note) {
    await fill('Movement', reason); await fill(reason === 'adjustment' ? 'Counted quantity' : 'Movement quantity', amount); await fill('Reason / reference', note); await click('Record movement');
    await waitFor(() => field('Reason / reference')?.value === '', 'movement saved');
  }
  await movement('purchase', '0.25', 'Delivery'); check((await current()).qty === 0.35, 'Receiving stock increases balance');
  await movement('wastage', '0.05', 'Spill'); check((await current()).qty === 0.3, 'Wastage decreases balance');
  await movement('adjustment', '0.125', 'Physical count'); check((await current()).qty === 0.125, 'Physical count records a correction');
  await fill('Movement', 'adjustment'); await fill('Counted quantity', '0.05'); await fill('Reason / reference', 'Stale count');
  stock = await current();
  await api(`/stock-items/${stock.id}/movements`, 'POST', { clientRef: `counter-${suffix}`, expectedVersion: stock.version, reason: 'purchase', quantity: 0.1, note: 'Other counter' });
  await click('Record movement'); await waitFor(() => document.body.innerText.includes('Stock changed on another counter'), 'stale count rejected');
  check((await current()).qty === 0.225, 'Concurrent stock change cannot be overwritten by an old count');
  await click('Refresh balance'); await movement('adjustment', '0.2', 'Reviewed count');
  check((await current()).qty === 0.2, 'Refreshed count succeeds');
  const moves = (await api(`/stock-items/${stock.id}/movements`)).movements;
  check(Math.round(moves.reduce((sum, m) => sum + m.delta, 0) * 1000) === 200, 'Movement history reconciles to the current balance');
  check(moves.some((m) => m.reason === 'cancel_reversal' && m.orderId === kitchenOrder.id) && moves.some((m) => m.reason === 'sale' && m.orderId === parcelOrder.id), 'History links sales and reversals to orders');
  await fill('Show stock', 'low');
  check(!button(`Manage ${name}`), 'Replenished item leaves the low-stock filter');
  await fill('Show stock', 'active'); await waitFor(() => button(`Manage ${name}`), 'active stock');
  check(document.body.innerText.includes('Movement history'), 'Movement history is visible in the inventory screen');
  window.__m5Report = { checks, stockId: stock.id, stockName: name };
  return window.__m5Report;
})()
