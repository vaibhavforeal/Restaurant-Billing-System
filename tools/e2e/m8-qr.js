// Run via agent-browser eval --stdin on a disposable QA server with the seeded
// recipe bowl and an authenticated, registered Pro administrator. Never use live data.
(async () => {
  if (location.origin !== 'http://127.0.0.1:4117') throw new Error('Use the isolated QR QA server on 4117');
  const checks = [], writes = [], originalConfirm = window.confirm;
  const check = (ok, label) => { if (!ok) throw new Error(label); checks.push(label); };
  const pause = (ms = 70) => new Promise((resolve) => setTimeout(resolve, ms));
  const wait = async (fn, label) => { const end = Date.now() + 10000; while (Date.now() < end) { const value = fn(); if (value) return value; await pause(); } throw new Error('Timed out: ' + label); };
  const activeModal = (doc) => [...doc.querySelectorAll('dialog[open]')].reverse().find((dialog) => dialog.matches(':modal'));
  const available = (element) => {
    if (!element?.isConnected || element.closest('[hidden],[inert]') || !element.getClientRects().length) return false;
    const doc = element.ownerDocument, modal = activeModal(doc), style = doc.defaultView.getComputedStyle(element);
    if ((modal && !modal.contains(element)) || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    const frame = doc.defaultView.frameElement;
    return !frame || available(frame);
  };
  const btn = (doc, label) => [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === label && available(b));
  const click = async (doc, label) => { const b = await wait(() => { const b = btn(doc, label); return b && !b.disabled ? b : null; }, label); b.click(); await pause(); };
  const closeDialogs = async () => {
    let modal;
    while ((modal = activeModal(document))) {
      await click(modal, 'Close');
      await wait(() => !modal.open, 'staff dialog closed');
    }
  };
  const openStaffDialog = async (label) => { await closeDialogs(); await click(document, label); return wait(() => activeModal(document), label + ' dialog'); };
  const field = (doc, label) => [...doc.querySelectorAll('label')].find((l) => l.textContent.trim().startsWith(label) && available(l))?.querySelector('select,input,textarea');
  const fill = async (doc, label, value) => {
    const input = await wait(() => { const el = field(doc, label); return el && !el.disabled ? el : null; }, label);
    const view = doc.defaultView;
    const proto = input.tagName === 'SELECT' ? view.HTMLSelectElement.prototype : input.tagName === 'TEXTAREA' ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value);
    input.dispatchEvent(new view.Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); await pause();
  };
  const headers = { authorization: `Bearer ${localStorage.getItem('forkflow.token')}`, 'x-forkflow-device': localStorage.getItem('forkflow.device.v1'), 'content-type': 'application/json' };
  const api = async (path, method = 'GET', body) => {
    const r = await fetch('/api' + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = r.status === 204 ? null : await r.json();
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(data)}`); return data;
  };
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;right:8px;bottom:8px;width:390px;height:500px;z-index:9000;background:white;border:2px solid #bbb';
  window.__m8Report = { status: 'running', checks };
  try {
    const devicesBefore = (await api('/license/devices')).devices.length;
    const { table } = await api('/tables', 'POST', { name: 'QR Browser ' + Date.now(), area: 'QA' });
    const { products } = await api('/products');
    const bowl = products.find((p) => p.name === 'Paneer rice bowl');
    const large = bowl.variants.find((v) => v.name === 'Large');
    const stockBefore = (await api('/stock-items')).items.find((s) => s.name === 'Rice').qty;
    await closeDialogs();
    if (btn(document, '\u2190 Back')) await click(document, '\u2190 Back');
    else if (!btn(document, 'tables').disabled) await click(document, 'tables');
    await openStaffDialog('Table QR codes');
    await click(document, 'Refresh codes');
    await fill(document, 'Table', table.id);
    await fill(document, 'Restaurant network address', location.origin);
    await click(document, 'Enable QR code');
    const link = await wait(() => field(document, 'Guest menu link')?.value, 'generated QR link');
    const token = new URL(link).hash.slice(1);
    check(link.startsWith(location.origin + '/menu#') && document.querySelector('.qr-code-preview img')?.src.startsWith('data:image/png'), 'Admin generates an opaque table URL and QR image');
    check(document.body.innerText.includes('works only on the main PC'), 'Loopback address explains that guest phones need a LAN address');
    let printed = false;
    const print = window.print;
    window.print = () => { printed = document.body.classList.contains('printing-table-qr') && document.querySelector('.qr-print-sheet h1')?.textContent === table.name; };
    await click(document, 'Print QR code'); window.print = print;
    check(printed && !document.body.classList.contains('printing-table-qr'), 'Print action selects the dedicated table QR sheet');
    await closeDialogs();
    iframe.src = link; document.body.append(iframe);
    const guest = await wait(() => iframe.contentDocument?.querySelector('.guest-menu-products') ? iframe.contentDocument : null, 'guest menu');
    check(!guest.querySelector('[aria-label="Main navigation"]') && guest.body.innerText.includes(table.name), 'Guest sees the table menu without staff navigation or PIN login');
    check(iframe.contentWindow.performance.getEntriesByType('resource').filter((r) => r.name.includes('/api/')).every((r) => r.name.includes('/api/guest/')), 'Guest bootstrap calls only guest APIs');
    await fill(guest, 'Choose an option', large.id);
    const bowlCard = [...guest.querySelectorAll('.guest-menu-product')].find((c) => c.textContent.includes('Paneer rice bowl'));
    if (!bowlCard) throw new Error('Recipe bowl card missing');
    bowlCard.querySelector('button').click(); await pause();
    guest.querySelector('[aria-label="Increase Paneer rice bowl (Large)"]').click(); await pause();
    await fill(guest, 'Instructions for Paneer rice bowl (Large)', 'Less spicy please');
    const guestFetch = iframe.contentWindow.fetch.bind(iframe.contentWindow);
    let loseFirst = true;
    iframe.contentWindow.fetch = async (url, init) => {
      const response = await guestFetch(url, init);
      if (String(url) === '/api/guest/requests' && init?.method === 'POST') {
        writes.push({ body: init.body, headers: init.headers, status: response.status });
        if (loseFirst) { loseFirst = false; throw new Error('Simulated lost response after commit'); }
      }
      return response;
    };
    const submitLabel = 'Submit to staff';
    if (!submitLabel) throw new Error('Submit request missing');
    await click(guest, submitLabel);
    await wait(() => btn(guest, 'Retry the same request'), 'ambiguous response retry');
    const pending = (await api('/qr/requests')).requests.find((r) => r.tableId === table.id);
    check(pending?.status === 'pending' && pending.items[0].qty === 2 && pending.items[0].pricePaise === 24000, 'Guest submission stores server-priced selections pending staff review');
    check(!(await api('/orders')).orders.some((o) => o.tableId === table.id), 'Pending requests create no live order');
    await click(guest, 'Retry the same request');
    await wait(() => guest.querySelector('[aria-label="Request status"]'), 'guest receipt after retry');
    check(writes.length === 2 && writes[0].body === writes[1].body && writes[0].status === 201 && writes[1].status === 200, 'Lost-response retry sends the exact same request and returns its original receipt');
    check(writes.every((w) => !w.headers.authorization && !w.headers['x-forkflow-device']), 'Guest submission carries no staff session or device credentials');
    const requestDialog = await openStaffDialog('Review requests');
    await click(document, 'Refresh requests');
    const card = await wait(() => requestDialog.querySelector(`[aria-label="QR request from ${table.name}"]`), 'staff pending card');
    check(btn(card, 'Accept & open order').disabled, 'Staff must explicitly choose a bill group');
    await fill(document, 'Bill group for ' + table.name, 'new');
    await click(card, 'Accept & open order');
    await wait(() => btn(document, 'Send to kitchen'), 'accepted order screen');
    const order = (await api('/orders')).orders.find((o) => o.tableId === table.id);
    check(order.items.length === 1 && order.items[0].status === 'pending' && order.items[0].note === 'Less spicy please' && order.kots.length === 0, 'Acceptance opens the correct table order with pending items and notes');
    check((await api('/stock-items')).items.find((s) => s.name === 'Rice').qty === stockBefore, 'Acceptance leaves recipe stock unchanged');
    await click(document, 'Send to kitchen');
    await wait(() => !btn(document, 'Send to kitchen') || btn(document, 'Send to kitchen').disabled, 'kitchen send');
    check((await api('/stock-items')).items.find((s) => s.name === 'Rice').qty === stockBefore - 0.25, 'Normal kitchen send deducts the two portions using the recipe');
    await wait(() => guest.body.innerText.includes('accepted'), 'guest acceptance status');
    check((await api('/license/devices')).devices.length === devicesBefore, 'Guest browsing, submitting and tracking consume no staff-device slot');
    window.__m8Report = { status: 'passed', checks, tableId: table.id, orderId: order.id, link };
    return window.__m8Report;
  } catch (e) { window.__m8Report = { status: 'failed', checks, error: String(e) }; throw e; }
  finally { iframe.remove(); window.confirm = originalConfirm; }
})()
