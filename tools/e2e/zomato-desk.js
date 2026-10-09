// Run on the disposable Zomato desk fixture (tools/e2e/zomato-desk-server.mts, port 4150), signed in as admin (1234).
// Zomato and the Kitchen Display are ON in the fixture; "Paneer tikka" costs 300 base, 260 Takeaway and 240 Zomato on a kitchen station.
// Punches in Zomato order E2E-1, runs it Preparing, Ready, Picked up, then checks the bill, the duplicate refusal, the
// dashboard card, the day-end receivable and the reconciliation row. Who sees the section is zomato-desk-roles.js. The result is window.__zomatoDeskResult
// (progress in window.__zomatoDeskProgress). Restart the fixture before repeating the gate (E2E-1 stays reserved).
// Never run this against a restaurant database.
(async () => {
  if (location.origin !== 'http://127.0.0.1:4150') throw new Error('Disposable Zomato desk fixture only');
  const checks = [];
  window.__zomatoDeskProgress = checks;
  const check = (ok, name) => { if (!ok) throw new Error(name); checks.push(name); };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const wait = async (predicate, label) => {
    const until = Date.now() + 10000;
    for (;;) { const value = await predicate(); if (value) return value; if (Date.now() > until) throw new Error('Timed out: ' + label); await sleep(40); }
  };
  const nativeFetch = window.fetch, nativeConfirm = window.confirm;
  const device = localStorage.getItem('forkflow.device.v1');
  const call = async (method, path, token, body) => {
    const headers = { authorization: 'Bearer ' + token, 'x-forkflow-device': device };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await nativeFetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const ownToken = localStorage.getItem('forkflow.token');
  const login = async pin => (await (await nativeFetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forkflow-device': device }, body: JSON.stringify({ pin }) })).json()).token;
  const setValue = (e, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, value); e.dispatchEvent(new Event('input', { bubbles: true })); };
  const navItem = label => [...document.querySelectorAll('.nav-item')].find(e => e.getAttribute('aria-label') === label);
  const goto = async label => { await wait(() => navItem(label) && !navItem(label).disabled, 'nav ' + label); navItem(label).click(); await sleep(80); };
  const button = (name, root = document) => [...root.querySelectorAll('button')].find(b => b.textContent.trim() === name);
  const clickButton = async (name, root = document) => { const b = await wait(() => { const e = button(name, root); return e && !e.disabled ? e : null; }, 'enabled button ' + name); b.click(); await sleep(60); };
  const presetTab = name => [...document.querySelectorAll('.sales-presets button')].find(b => b.textContent === name);
  const zomatoApi = async () => (await call('GET', '/api/orders', ownToken)).json.orders.filter(o => o.type === 'zomato');
  const cards = () => [...document.querySelectorAll('.zomato-desk-card')];
  const cardFor = id => cards().find(c => c.querySelector('.zomato-desk-id')?.textContent === '#' + id);
  const money = n => '₹' + (n / 100).toFixed(2);
  const PRICE = 24000;
  const punchIn = async id => {
    await clickButton('+ New', document.querySelector('.tables-zomato'));
    const input = await wait(() => document.querySelector('dialog[open] .zomato-new-form input'), 'new order dialog');
    setValue(input, id); await sleep(40);
    document.querySelector('dialog[open] .zomato-new-form button.primary').click();
  };

  try {
    const me = (await call('GET', '/api/me', ownToken)).json.user;
    check(me.role === 'admin', 'Signed in as admin');

    // ---------- Who sees the Zomato section ----------
    await goto('tables'); await wait(() => document.querySelector('.tables-zomato'), 'Zomato panel');
    check(!!document.querySelector('.tables-zomato .zomato-desk-new') && document.querySelector('.tables-zomato h3').textContent === 'Zomato' && !!document.querySelector('.zomato-desk-empty'), 'Admin sees the Zomato section with + New and no open orders');
    const waiterToken = await login('3456'), cashierToken = await login('2345');
    check((await call('POST', '/api/orders', waiterToken, { clientRef: 'w-' + Date.now(), type: 'zomato', zomatoOrderId: 'W-1' })).status === 403, 'The server refuses a waiter creating a Zomato order');
    check((await call('POST', '/api/orders', cashierToken, { clientRef: 'c-' + Date.now(), type: 'zomato', zomatoOrderId: 'C-0' })).status < 300, 'A cashier may punch in a Zomato order');
    const strayId = (await zomatoApi()).find(o => o.zomatoOrderId === 'C-0').id;
    check((await call('POST', `/api/orders/${strayId}/cancel`, cashierToken, { reason: 'Gate cleanup' })).status < 300, 'The cashier test order is cancelled again');

    // ---------- Punch in E2E-1 ----------
    await punchIn('E2E-1');
    await wait(() => document.querySelector('.order-header h2')?.textContent.startsWith('Zomato #E2E-1'), 'order screen');
    check(document.querySelector('.order-header h2').textContent.startsWith('Zomato #E2E-1'), 'New with ID E2E-1 opens "Zomato #E2E-1"');
    const menu = document.querySelector('.menu-browser').textContent;
    check(menu.includes('Zomato prices') && menu.includes(money(PRICE)) && !menu.includes(money(26000)) && !menu.includes(money(30000)), 'The menu shows the Zomato price, not Takeaway or base');
    check(document.querySelector('.billing-panel .zomato-desk-pill')?.textContent === 'New' && button('Add items')?.disabled === true && !button('Bill') && !button('Discount') && ![...document.querySelectorAll('button')].some(b => /^Pay\b/.test(b.textContent.trim())), 'A new order shows the New pill and no bill, discount or pay controls');

    // ---------- Add an item, Send KOT, Preparing ----------
    document.querySelector('.menu-card').click(); await sleep(80);
    document.querySelector('[data-shortcut="send_kitchen"]').click();
    await wait(() => document.querySelector('.billing-panel .zomato-desk-pill')?.textContent === 'Preparing', 'Preparing pill');
    const order = (await zomatoApi()).find(o => o.zomatoOrderId === 'E2E-1');
    check(order.zomatoStatus === 'preparing' && order.items.length === 1 && order.items[0].pricePaise === PRICE, 'Send KOT moves the order to Preparing at the Zomato price');
    const kots = (await call('GET', '/api/kots', ownToken)).json;
    check((kots.kots ?? []).some(k => k.orderId === order.id && k.zomatoOrderId === 'E2E-1'), 'The KOT carries the Zomato order ID');
    check(button('Ready') && !button('Ready').disabled, 'The order screen offers Ready');

    // ---------- Card: Preparing, then Ready, then Picked up ----------
    document.querySelector('.order-header [data-shortcut="tables"]').click();
    await wait(() => cardFor('E2E-1'), 'Zomato card');
    check(cardFor('E2E-1').querySelector('.zomato-desk-pill').textContent === 'Preparing' && cardFor('E2E-1').textContent.includes(money(PRICE)) && document.querySelector('.tables-zomato .panel-title span').textContent === '1', 'The card shows Preparing, the total and a count of 1');
    await clickButton('Ready', cardFor('E2E-1'));
    await wait(() => cardFor('E2E-1')?.querySelector('.zomato-desk-pill').textContent === 'Ready', 'Ready pill');
    check(!!button('Picked up', cardFor('E2E-1')) && (await zomatoApi()).find(o => o.zomatoOrderId === 'E2E-1').zomatoStatus === 'ready', 'Ready is saved and the card offers Picked up');
    let confirmText = '';
    window.confirm = text => { confirmText = text; return true; };
    await clickButton('Picked up', cardFor('E2E-1'));
    await wait(() => !cardFor('E2E-1'), 'card gone');
    check(confirmText === 'Close Zomato #E2E-1?' && cards().length === 0 && !!document.querySelector('.zomato-desk-empty'), 'Picked up asks for confirmation and the card is gone');
    window.confirm = nativeConfirm;

    // ---------- The bill ----------
    const bills = (await call('GET', '/api/bills?status=all', ownToken)).json.bills.filter(b => b.receipt.orderType === 'zomato');
    const bill = bills[0];
    check(bills.length === 1 && bill.totalPaise === PRICE && bill.status === 'paid' && bill.receipt.zomatoOrderId === 'E2E-1' && bill.receipt.gstPaidBy === 'zomato', 'One paid Zomato bill at the item value, marked GST paid by Zomato');
    await goto('Reports & Analytics'); await wait(() => presetTab('Bills'), 'Bills tab'); presetTab('Bills').click();
    const showSelect = await wait(() => document.querySelector('.pos-history select'), 'Bills filter');
    showSelect.value = 'all'; showSelect.dispatchEvent(new Event('change', { bubbles: true }));
    const row = await wait(() => [...document.querySelectorAll('.pos-history tbody tr')].find(r => r.textContent.includes('Zomato #E2E-1')), 'Zomato bill row');
    check(row.textContent.includes(money(PRICE)), 'Bills lists "Zomato #E2E-1" with its total');
    button(`Open bill #${bill.billNo}`, row).click();
    await clickButton('View bill', await wait(() => document.querySelector('.billing-panel'), 'billing panel'));
    const dialog = await wait(() => document.querySelector('dialog[open]')?.textContent.includes('Tax details') ? document.querySelector('dialog[open]') : null, 'bill dialog');
    check(dialog.textContent.includes('GST paid by Zomato (section 9(5))') && dialog.textContent.includes('Paid: Zomato ' + money(PRICE)) && !/CGST|SGST|Includes GST/.test(dialog.textContent) && !dialog.querySelector('.bill-tax-details table'), 'The bill shows "GST paid by Zomato (section 9(5))", no GST, no per-rate GST rows and the Zomato payment');
    await clickButton('View receipt', dialog);
    const receiptFrame = await wait(() => document.querySelector('dialog[open] iframe'), 'receipt frame');
    const receiptHtml = receiptFrame.getAttribute('srcdoc') ?? '';
    check(receiptHtml.includes('<dd>Zomato</dd>') && receiptHtml.includes('Zomato #E2E-1') && receiptHtml.includes('GST paid by Zomato (section 9(5))') && !/Dine-in|Prices include GST|GST added to menu prices|Includes GST|CGST/.test(receiptHtml), 'The on-screen receipt names the service Zomato and the order Zomato #E2E-1, with the 9(5) note and no GST lines');
    const labels = [...document.querySelectorAll('button')].map(b => b.textContent.trim());
    check(!labels.some(t => /print|reprint|credit note|refund|void/i.test(t)), 'The Zomato bill has no Print, Reprint, Credit note, Refund or Void button');
    check((await call('POST', `/api/bills/${bill.id}/print`, ownToken, {})).status === 409, 'The server refuses to print a Zomato bill');

    document.querySelectorAll('dialog[open]').forEach(d => d.close());

    // ---------- Duplicate ID ----------
    document.querySelector('.order-header [data-shortcut="tables"]')?.click();
    await wait(() => document.querySelector('.tables-zomato .zomato-desk-new'), 'Zomato panel');
    await punchIn('E2E-1');
    await wait(() => /already on the desk/.test(document.querySelector('dialog[open] [role="alert"]')?.textContent ?? ''), 'duplicate message');
    check(document.querySelector('dialog[open] [role="alert"]').textContent.includes('Zomato order E2E-1 is already on the desk') && (await zomatoApi()).length === 0 && document.querySelector('.order-header') === null, 'Punching E2E-1 again is refused with the server message and no new open order');
    const dupe = await call('POST', '/api/orders', ownToken, { clientRef: 'dupe-' + Date.now(), type: 'zomato', zomatoOrderId: 'E2E-1' });
    check(dupe.status === 409 && dupe.json.code === 'zomato_duplicate', 'The API answers 409 zomato_duplicate');
    document.querySelector('dialog[open]')?.close();
    await sleep(100);

    // ---------- Dashboard, day-end, reconciliation ----------
    await goto('home');
    await wait(() => { const e = document.querySelector('.dash-channel-zomato .dash-channel-amount'); return e && e.textContent !== '—'; }, 'dashboard Zomato card');
    check(document.querySelector('.dash-channel-zomato .dash-channel-amount').textContent === money(PRICE) && document.querySelector('.dash-channel-zomato small').textContent === '1 Order' && document.querySelector('.dash-channel-total .dash-channel-amount').textContent === money(PRICE), 'The dashboard Zomato card shows the sale and is part of Total Sales');
    await goto('Reports & Analytics'); await wait(() => presetTab('Day-end / GST'), 'Day-end tab'); presetTab('Day-end / GST').click();
    // Scoped to the Day-end screen: the Sales metrics also have a "Zomato receivable (outstanding)" card.
    const receivable = await wait(() => [...document.querySelectorAll('.sales-reports .legacy-screen p')].find(p => p.textContent.startsWith('Zomato receivable (outstanding)')), 'day-end receivable');
    check(receivable.textContent.includes(money(PRICE)), 'Day-end shows "Zomato receivable (outstanding)" with the bill value');
    const dayEnd = (await call('GET', '/api/reports/day-end', ownToken)).json.report;
    check(dayEnd.zomatoReceivablePaise === PRICE && dayEnd.payments.every(p => !['cash', 'upi', 'card'].includes(p.mode)), 'The receivable is not counted as cash, UPI or card collections');
    // The fixture issues no other bill, so the restaurant's own GST breakdown is empty.
    const supplies = [...document.querySelectorAll('.sales-reports .legacy-screen p')].find(p => p.textContent.startsWith('Supplies under section 9(5) (GST paid by Zomato)'));
    check(!!supplies && supplies.textContent.includes(money(PRICE)) && dayEnd.zomatoSuppliesPaise === PRICE && dayEnd.taxes.length === 0 && dayEnd.net.taxablePaise === 0, 'Day-end keeps the Zomato bill out of the GST breakdown and shows it as a section 9(5) supply');
    await wait(() => presetTab('Zomato reconciliation'), 'Zomato reconciliation tab'); presetTab('Zomato reconciliation').click();
    const reconRow = await wait(() => [...document.querySelectorAll('.zomato-table tbody tr')].find(r => r.textContent.includes('E2E-1')), 'reconciliation row');
    check(reconRow.textContent.includes(money(PRICE)) && /Awaiting statement/.test(reconRow.textContent), 'Reports, Zomato reconciliation lists E2E-1 awaiting its payout statement');

    window.__zomatoDeskResult = { status: 'passed', total: checks.length, checks };
    return window.__zomatoDeskResult;
  } catch (error) { window.__zomatoDeskResult = { status: 'failed', checks, error: String(error) }; throw error; }
  finally { window.confirm = nativeConfirm; window.fetch = nativeFetch; }
})();
