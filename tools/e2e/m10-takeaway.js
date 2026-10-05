// Run with agent-browser eval --stdin in the registered admin browser on :4121.
// Seed window.__m10BasicLicense from the disposable fixture before the first run.
// A reload-required result means reload the page, then run this same file again.
// Uses real UI actions; APIs only prepare fixtures and inspect persisted results.
(async () => {
  if (location.origin !== 'http://127.0.0.1:4121') throw new Error('Disposable http://127.0.0.1:4121 only');
  const stateKey = 'forkflow.qa.m10.takeaway';
  const state = JSON.parse(localStorage.getItem(stateKey) || 'null') || { phase: 'normal', checks: [], orders: [], bills: [] };
  if (state.phase === 'complete') return { status: 'passed', passed: state.checks.length, checks: state.checks, orders: state.orders, bills: state.bills };
  if (window.__m10NeedsReload === state.phase) return { status: 'reload-required', nextPhase: state.phase, message: 'Reload this disposable page before resuming.' };
  const pause = (ms = 70) => new Promise(resolve => setTimeout(resolve, ms));
  const nativeFetch = window.__m10NativeFetch || window.fetch.bind(window);
  window.__m10NativeFetch = nativeFetch;
  let keepFault = false;
  const save = () => localStorage.setItem(stateKey, JSON.stringify(state));
  const check = (ok, label) => { if (!ok) throw new Error(label); state.checks.push(label); save(); };
  const wait = async (fn, label) => {
    const until = Date.now() + 18000;
    while (Date.now() < until) { const value = await fn(); if (value) return value; await pause(); }
    throw new Error('Timed out: ' + label + '. Page: ' + document.body.innerText.slice(-1500));
  };
  const visible = value => !!value && value.getClientRects().length > 0 && getComputedStyle(value).visibility !== 'hidden' && !value.closest('[hidden],[inert]');
  const actionScope = () => document.querySelector('dialog[open]') || document;
  const button = label => [...actionScope().querySelectorAll('button')].find(value => visible(value) && (value.textContent.trim() === label || value.getAttribute('aria-label') === label));
  const click = async (label, twice = false) => {
    const value = await wait(() => { const b = button(label); return b && !b.matches(':disabled') ? b : null; }, 'enabled ' + label);
    value.click(); if (twice) value.click(); await pause();
  };
  const field = label => [...actionScope().querySelectorAll('label')].filter(value => value.textContent.trim().startsWith(label)).map(value => value.querySelector('input,select')).find(visible);
  const fill = async (label, value) => {
    const input = await wait(() => { const value = field(label); return value && !value.matches(':disabled') ? value : null; }, 'field ' + label);
    const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    await pause();
  };
  async function closeBilling() {
    if (!document.querySelector('dialog.billing-dialog[open]')) return;
    await click('Close billing');
    await wait(() => !document.querySelector('dialog.billing-dialog[open]'), 'billing dialog closed');
  }
  async function showPane(pane) {
    const toggle = actionScope().querySelector('.order-pane-switch [aria-controls="order-' + pane + '"]');
    if (visible(toggle) && toggle.getAttribute('aria-pressed') !== 'true') { toggle.click(); await pause(); }
  }
  async function chooseCategory() {
    await showPane('menu');
    const select = await wait(() => {
      const value = actionScope().querySelector('select[aria-label="Menu category"]');
      return visible(value) && !value.disabled && [...value.options].some(option => option.value === state.category.id) ? value : null;
    }, 'menu category');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, state.category.id);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await pause();
  }
  const headers = { authorization: 'Bearer ' + localStorage.getItem('forkflow.token'), 'x-forkflow-device': localStorage.getItem('forkflow.device.v1'), 'content-type': 'application/json' };
  const api = async (path, method = 'GET', body) => {
    const response = await nativeFetch('/api' + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    if (!response.ok) throw new Error(path + ': ' + JSON.stringify(result));
    return result;
  };
  const queues = () => Object.keys(localStorage).filter(key => key.startsWith('forkflow.queue.v1.')).map(key => JSON.parse(localStorage.getItem(key)));
  const reloadNext = phase => {
    state.phase = phase; save(); window.__m10NeedsReload = phase; keepFault = true;
    return { status: 'reload-required', nextPhase: phase, passed: state.checks.length, checks: state.checks };
  };
  function loseResponse(path) {
    const fault = { path, lost: false, bodies: [] };
    window.fetch = async (url, init) => {
      if (String(url) !== path || init?.method !== 'POST') return nativeFetch(url, init);
      fault.bodies.push(String(init.body));
      if (fault.lost) throw new TypeError('M10 controlled disconnect after lost response');
      const response = await nativeFetch(url, init);
      if (!response.ok) return response;
      fault.lost = true;
      throw new TypeError('M10 lost successful response');
    };
    return fault;
  }
  let takeawayKey;
  const savedTakeaway = () => JSON.parse(localStorage.getItem(takeawayKey) || 'null');
  const currentOrder = async () => (await api('/orders/' + savedTakeaway().orderId)).order;
  const currentBill = async () => (await api('/orders/' + savedTakeaway().orderId + '/bill')).bill;
  const draftKey = id => `forkflow.draft.${state.userId}.${id}`;
  const draft = id => JSON.parse(localStorage.getItem(draftKey(id)) || '[]');
  async function home() {
    await closeBilling();
    const value = await wait(() => button('home'), 'home navigation');
    if (!value.disabled) await click('home');
  }
  async function openQuick() {
    await home();
    await click('Takeaway', true);
    await wait(() => document.querySelector('.order-screen select[aria-label="Menu category"]') && savedTakeaway()?.orderId, 'quick takeaway menu');
    await showPane('cart');
    await wait(() => button('Checkout'), 'quick takeaway cart');
    await wait(() => localStorage.getItem('forkflow.generation'), 'checked server generation');
    return savedTakeaway().orderId;
  }
  async function next() {
    const prior = savedTakeaway().orderId;
    await closeBilling();
    await click('Next takeaway', true);
    await wait(() => savedTakeaway()?.orderId && savedTakeaway().orderId !== prior && document.querySelector('.order-screen select[aria-label="Menu category"]'), 'next empty takeaway menu');
    await showPane('cart');
    await wait(() => button('Checkout'), 'next empty takeaway');
    const order = await currentOrder();
    check(order.type === 'parcel' && order.status === 'open' && order.items.length === 0, 'Next takeaway starts one empty parcel');
    check((await api('/orders')).orders.filter(value => value.clientRef === order.clientRef).length === 1, 'Double-click Next takeaway creates no duplicate parcel');
    return order.id;
  }
  async function add(product) {
    await chooseCategory();
    const value = await wait(() => [...actionScope().querySelectorAll('button.menu-card')].find(b => visible(b) && b.textContent.includes(product.name) && !b.disabled), 'menu item ' + product.name);
    value.click(); await pause();
  }
  async function checkout() {
    await showPane('cart');
    await click('Checkout', true);
    await wait(() => field('Payment method') && button('Issue bill & record cash payment'), 'checkout total and payment method');
    return (await api('/orders/' + savedTakeaway().orderId + '/bill-preview', 'POST', {})).preview;
  }
  async function paid(mode, twice = true) {
    await fill('Payment method', mode);
    await click('Issue bill & record ' + (mode === 'upi' ? 'UPI' : mode) + ' payment', twice);
    await wait(() => actionScope().querySelector('.billing-paid')?.textContent.includes('Paid:'), 'paid confirmation');
    await closeBilling();
    await wait(() => button('Next takeaway'), 'paid takeaway');
    const bill = await currentBill(), order = await currentOrder();
    check(bill.status === 'paid' && bill.payments.length === 1 && bill.payments[0].mode === mode && bill.payments[0].amountPaise === bill.totalPaise, mode.toUpperCase() + ' records one exact payment');
    check(order.status === 'settled', mode.toUpperCase() + ' closes the parcel');
    check((await api('/bills?status=all')).bills.filter(value => value.orderId === order.id).length === 1, mode.toUpperCase() + ' double-click issues one bill');
    state.orders.push(order.id); state.bills.push(bill.id); save(); return bill;
  }
  async function stockMoves(stockId, orderId) { return (await api('/stock-items/' + stockId + '/movements')).movements.filter(move => move.orderId === orderId && move.reason === 'sale'); }
  try {
    const { user } = await api('/me');
    if (user.role !== 'admin') throw new Error('Registered disposable admin session required');
    state.userId = user.id; takeawayKey = 'forkflow.draft.takeaway.' + user.id;
    await wait(() => localStorage.getItem('forkflow.generation'), 'server generation');
    if (state.phase === 'normal') {
      if (!window.__m10BasicLicense) throw new Error('Seed window.__m10BasicLicense from the disposable :4121 fixture first');
      if (queues().length) throw new Error('Disposable test browser must begin without queued requests');
      const stamp = Date.now();
      state.category = (await api('/categories', 'POST', { name: 'Takeaway gate ' + stamp })).category;
      const station = (await api('/kot-stations')).stations[0];
      state.meal = (await api('/products', 'POST', { categoryId: state.category.id, name: 'Gate bowl ' + stamp, pricePaise: 10000, gstRate: 5, kotStationId: station.id })).product;
      state.water = (await api('/products', 'POST', { categoryId: state.category.id, name: 'Gate bottle ' + stamp, pricePaise: 2500, gstRate: 0, kotStationId: null })).product;
      state.rice = (await api('/stock-items', 'POST', { clientRef: crypto.randomUUID(), name: 'Gate rice ' + stamp, unit: 'kg', openingQty: 20 })).item;
      state.bottles = (await api('/stock-items', 'POST', { clientRef: crypto.randomUUID(), name: 'Gate bottles ' + stamp, unit: 'pcs', openingQty: 50 })).item;
      await api('/products/' + state.meal.id + '/stock-links', 'PUT', { expectedVersion: 0, stockItemId: state.rice.id, qtyPerSale: 0.25 });
      await api('/products/' + state.water.id + '/stock-links', 'PUT', { expectedVersion: 0, stockItemId: state.bottles.id, qtyPerSale: 1 });
      const settings = (await api('/settings')).settings;
      await api('/settings', 'PUT', { ...settings, taxInclusive: false });
      const orderId = await openQuick(); await add(state.meal); await add(state.water);
      await showPane('cart'); await click('Increase ' + state.meal.name);
      check(draft(orderId).length === 2 && draft(orderId).find(item => item.productId === state.meal.id).qty === 2, 'Quick cart persists item quantities before checkout');
      check((await currentOrder()).items.length === 0 && !button('Punch') && !button('Send to kitchen'), 'Quick flow needs no manual punch or kitchen send');
      const preview = await checkout();
      const prepared = await currentOrder(), kots = (await api('/kots')).kots.filter(kot => kot.orderId === orderId);
      check(draft(orderId).length === 0 && prepared.items.length === 2, 'Checkout saves exactly two cart rows');
      check(prepared.items.find(item => item.productId === state.meal.id).status === 'sent' && prepared.items.find(item => item.productId === state.water.id).status === 'pending', 'Checkout sends kitchen items and leaves stationless items for billing');
      check(kots.length === 1 && kots[0].items.length === 1 && kots[0].items[0].qty === 2, 'Double-click checkout creates one exact KOT');
      const mealMoves = await stockMoves(state.rice.id, orderId);
      check(mealMoves.length === 1 && mealMoves[0].delta === -0.5, 'Kitchen stock is deducted exactly once at checkout');
      check((await stockMoves(state.bottles.id, orderId)).length === 0, 'Stationless stock is not deducted before bill issue');
      check(preview.totalPaise === 23500 && preview.subtotalPaise === 22500 && !preview.taxInclusive, 'Checkout preview has exact menu subtotal and GST total');
      await fill('Cash received', '1'); check(button('Issue bill & record cash payment').disabled, 'Insufficient cash blocks payment confirmation');
      await fill('Cash received', '300'); check(document.querySelector('.quick-payment').textContent.includes('65.00'), 'Cash change is calculated from cash received');
      const cash = await paid('cash');
      const bottleMoves = await stockMoves(state.bottles.id, orderId);
      check(bottleMoves.length === 1 && bottleMoves[0].delta === -1 && (await stockMoves(state.rice.id, orderId)).length === 1, 'Bill issue deducts stationless stock once without rededucting kitchen stock');
      await click('View bill'); await click('View receipt');
      await wait(() => actionScope().querySelector('.billing-receipt-frame')?.contentDocument?.body?.innerText.includes('CASH'), 'paid receipt HTML');
      check(actionScope().querySelector('.billing-receipt-frame').contentDocument.body.innerText.includes('235.00'), 'Paid receipt shows the recorded amount rather than cash tendered');
      await next(); await add(state.water); await checkout(); await paid('upi');
      await next(); await add(state.meal); await checkout(); await paid('card');
      await api('/license', 'PUT', { license: window.__m10BasicLicense });
      window.dispatchEvent(new Event('forkflow:license-changed'));
      check((await api('/license')).plan === 'basic', 'Basic plan activated for normal takeaway coverage');
      await next(); await add(state.water); await checkout(); await paid('cash');
      check(true, 'Basic completes quick takeaway billing');
      const draftOrderId = await next(); await add(state.meal);
      const draftRef = draft(draftOrderId)[0].clientRef;
      await openQuick(); await wait(() => draft(draftOrderId).length === 1, 'draft reopened');
      check(savedTakeaway().orderId === draftOrderId && draft(draftOrderId)[0].clientRef === draftRef, 'Leaving and reopening retains the same order and immutable draft row');
      state.draftRecovery = { orderId: draftOrderId, draftRef }; save();
      return reloadNext('draft_reload');
    }
    if (state.phase === 'draft_reload') {
      await openQuick();
      check(savedTakeaway().orderId === state.draftRecovery.orderId && draft(savedTakeaway().orderId)[0]?.clientRef === state.draftRecovery.draftRef, 'Real page reload restores the original takeaway draft');
      check((await currentOrder()).items.length === 0, 'Draft recovery does not silently submit cart items');
      await checkout(); await paid('cash');
      const fault = loseResponse('/api/orders');
      await click('Next takeaway', true); await wait(() => fault.lost && button('Retry opening takeaway'), 'lost create response');
      const saved = savedTakeaway(), matching = (await api('/orders')).orders.filter(order => order.clientRef === saved.clientRef);
      check(saved.orderId === null && matching.length === 1, 'Lost create response leaves one server order and a durable unresolved reference');
      state.createRecovery = { clientRef: saved.clientRef, orderId: matching[0].id, body: fault.bodies[0] };
      check(JSON.parse(state.createRecovery.body).clientRef === saved.clientRef, 'Create retry identity is stored before the first request');
      return reloadNext('create_reload');
    }
    if (state.phase === 'create_reload') {
      const attempts = [];
      window.fetch = async (url, init) => { if (String(url) === '/api/orders' && init?.method === 'POST') attempts.push(String(init.body)); return nativeFetch(url, init); };
      await openQuick(); window.fetch = nativeFetch;
      check(savedTakeaway().orderId === state.createRecovery.orderId && savedTakeaway().clientRef === state.createRecovery.clientRef, 'Reload recovers the same order after losing its create response');
      check(attempts.length === 1 && attempts[0] === state.createRecovery.body, 'Create recovery replays the exact immutable request body');
      check((await api('/orders')).orders.filter(order => order.clientRef === state.createRecovery.clientRef).length === 1, 'Create recovery does not duplicate parcels');
      await add(state.meal); await add(state.water); await checkout();
      const orderId = savedTakeaway().orderId, path = '/api/orders/' + orderId + '/bill';
      const fault = loseResponse(path);
      await click('Issue bill & record cash payment', true);
      const queued = await wait(() => fault.lost && queues().find(request => request.path === path), 'saved lost bill response');
      const bill = (await api('/orders/' + orderId + '/bill')).bill;
      check(bill.status === 'unpaid' && bill.payments.length === 0, 'Lost bill response never claims payment was recorded');
      check(queued.body === fault.bodies[0], 'Bill retry keeps the original bill reference and preview snapshot');
      state.billRecovery = { orderId, billId: bill.id, billNo: bill.billNo, body: queued.body };
      return reloadNext('bill_reload');
    }
    if (state.phase === 'bill_reload') {
      await wait(() => !queues().some(request => request.path === '/api/orders/' + state.billRecovery.orderId + '/bill'), 'bill replay after reload');
      await home(); await click('Takeaway'); await click('Record payment'); await wait(() => button('Settle bill'), 'unpaid recovered bill');
      const bill = await currentBill();
      check(bill.id === state.billRecovery.billId && bill.billNo === state.billRecovery.billNo && bill.status === 'unpaid', 'Reload reconciles the original unpaid bill');
      check((await api('/bills?status=all')).bills.filter(value => value.orderId === state.billRecovery.orderId).length === 1, 'Bill replay after reload creates no duplicate invoice');
      await fill('Mode 1', 'card');
      const path = '/api/bills/' + bill.id + '/settle', fault = loseResponse(path);
      await click('Settle bill', true);
      const queued = await wait(() => fault.lost && queues().find(request => request.path === path), 'saved lost payment response');
      const paidBill = (await api('/bills/' + bill.id)).bill;
      check(paidBill.status === 'paid' && paidBill.payments.length === 1 && paidBill.payments[0].mode === 'card', 'Lost settlement response records the intended payment once');
      check(queued.body === fault.bodies[0], 'Settlement retry retains the immutable reference, method and amount');
      state.settleRecovery = { billId: bill.id, orderId: bill.orderId, totalPaise: bill.totalPaise, body: queued.body };
      return reloadNext('settle_reload');
    }
    if (state.phase === 'settle_reload') {
      await wait(() => !queues().some(request => request.path === '/api/bills/' + state.settleRecovery.billId + '/settle'), 'settlement replay after reload');
      const bill = (await api('/bills/' + state.settleRecovery.billId)).bill;
      check(bill.status === 'paid' && bill.payments.length === 1 && bill.payments[0].mode === 'card' && bill.payments[0].amountPaise === state.settleRecovery.totalPaise, 'Reloaded settlement replay keeps exactly one correct payment');
      check((await api('/orders/' + state.settleRecovery.orderId)).order.status === 'settled', 'Recovered paid takeaway remains settled');
      check((await stockMoves(state.rice.id, state.settleRecovery.orderId)).length === 1 && (await stockMoves(state.bottles.id, state.settleRecovery.orderId)).length === 1, 'Bill and settlement recovery do not duplicate either stock deduction');
      await closeBilling(); await click('bills'); await fill('Show', 'paid'); await click('Open bill #' + bill.billNo);
      await wait(() => button('Next takeaway'), 'recovered paid order'); await click('View bill'); await click('View receipt');
      await wait(() => actionScope().querySelector('.billing-receipt-frame')?.contentDocument?.body?.innerText.includes('CARD'), 'recovered paid receipt');
      check(true, 'Recovered paid receipt and Next takeaway are available');
      check(queues().length === 0, 'All reliable requests reconcile after response losses');
      state.phase = 'complete'; save();
      return { status: 'passed', passed: state.checks.length, checks: state.checks, orders: state.orders, bills: state.bills };
    }
    throw new Error('Unknown gate phase ' + state.phase);
  } catch (error) {
    save(); window.__m10TakeawayFailure = { phase: state.phase, checks: state.checks, error: String(error), page: document.body.innerText.slice(-2300) };
    return { status: 'failed', ...window.__m10TakeawayFailure };
  } finally {
    if (!keepFault) window.fetch = nativeFetch;
  }
})()
