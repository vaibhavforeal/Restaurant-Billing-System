// Run in a signed-in, registered admin browser on the disposable QA server only.
(async () => {
  if (location.origin !== 'http://127.0.0.1:4120') throw new Error('Disposable port4120 only');
  const checks = [], errors = [];
  const check = (ok, label) => { if (!ok) throw new Error(label); checks.push(label); };
  const pause = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async (fn, label) => { const until = Date.now() + 15000; while (Date.now() < until) { const value = fn(); if (value) return value; await pause(); } throw new Error('Timed out: ' + label); };
  const activeModal = doc => [...doc.querySelectorAll('dialog[open]')].reverse().find(dialog => dialog.matches(':modal'));
  const available = element => {
    if (!element?.isConnected || element.closest('[hidden],[inert]') || !element.getClientRects().length) return false;
    const doc = element.ownerDocument, modal = activeModal(doc), style = doc.defaultView.getComputedStyle(element);
    if ((modal && !modal.contains(element)) || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    const frame = doc.defaultView.frameElement;
    return !frame || available(frame);
  };
  const button = (scope, label) => [...scope.querySelectorAll('button')].find(b => b.textContent.trim() === label && available(b));
  const click = async (scope, label) => { const b = await wait(() => { const b = button(scope, label); return b && !b.disabled ? b : null; }, label); b.click(); await pause(); };
  const closeDialogs = async () => {
    let modal;
    while ((modal = activeModal(document))) {
      await click(modal, 'Close');
      await wait(() => !modal.open, 'staff dialog closed');
    }
  };
  const openStaffDialog = async label => { await closeDialogs(); await click(document, label); return wait(() => activeModal(document), label + ' dialog'); };
  const headers = { authorization: 'Bearer ' + localStorage.getItem('forkflow.token'), 'x-forkflow-device': localStorage.getItem('forkflow.device.v1'), 'content-type': 'application/json' };
  const api = async (path, method = 'GET', body) => { const res = await fetch('/api' + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const value = await res.json(); if (!res.ok) throw new Error(path + ': ' + JSON.stringify(value)); return value; };
  document.querySelectorAll('#guest-flow-qa').forEach(frame => frame.remove());
  await closeDialogs();
  if (button(document, '\u2190 Back')) await click(document, '\u2190 Back');
  if (!document.querySelector('[aria-label="Table service requests"]')) await click(document, 'tables');
  await wait(() => document.querySelector('[aria-label="Table service requests"]'), 'tables screen');
  const suffix = String(Date.now());
  const { table } = await api('/tables', 'POST', { name: 'Flow ' + suffix });
  const qr = (await api('/qr/tables/' + table.id, 'PUT', { enabled: true })).table;
  const { category } = await api('/categories', 'POST', { name: 'Flow ' + suffix });
  const { stations } = await api('/kot-stations');
  const { product } = await api('/products', 'POST', { categoryId: category.id, name: 'Flow bowl ' + suffix, pricePaise: 10000, gstRate: 5, description: 'Fresh rice with garden vegetables.', kotStationId: stations[0].id });
  const devicesBefore = (await api('/license/devices')).devices.length;
  const billCount = (await api('/bills')).bills.length;
  const frame = document.createElement('iframe');
  frame.id = 'guest-flow-qa'; frame.src = qr.path;
  frame.style.cssText = 'position:fixed;right:8px;bottom:8px;width:390px;height:620px;z-index:9000;background:white';
  document.body.append(frame);
  const guestReady = () => frame.contentDocument?.querySelector('[aria-label="Add ' + product.name + '"]') ? frame.contentDocument : null;
  let guest = await wait(guestReady, 'guest menu');
  frame.contentWindow.addEventListener('error', e => errors.push(e.message));
  try {
    check(guest.body.innerText.includes(product.description), 'Guest menu displays the saved description');
    await click(guest, 'Call waiter'); await click(guest, 'Request bill');
    await wait(() => guest.querySelectorAll('.guest-service-pending').length === 2, 'both service receipts');
    const inbox = await openStaffDialog('View service requests');
    const waiterCall = await wait(() => inbox.querySelector('[aria-label="Waiter call from ' + table.name + '"]'), 'live waiter call');
    const billCall = await wait(() => inbox.querySelector('[aria-label="Bill request from ' + table.name + '"]'), 'live bill call');
    check(true, 'Waiter and bill calls reach staff through live updates');
    await click(waiterCall, 'Mark handled'); await click(billCall, 'Mark handled');
    await wait(() => guest.querySelectorAll('.guest-service-resolved').length === 2, 'guest handled confirmations');
    check((await api('/bills')).bills.length === billCount, 'Service requests and handling create no bills');
    check(true, 'Guests see both staff handling confirmations');
    await closeDialogs();
    guest.querySelector('[aria-label="Add ' + product.name + '"]').click(); await pause();
    await click(guest, 'Submit to staff');
    await wait(() => guest.querySelector('.guest-menu-request-pending'), 'request awaiting review');
    const requestDialog = await openStaffDialog('Review requests');
    const card = await wait(() => requestDialog.querySelector('[aria-label="QR request from ' + table.name + '"]'), 'staff review card');
    const select = card.querySelector('select');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'new');
    select.dispatchEvent(new Event('change', { bubbles: true })); await pause();
    await click(card, 'Accept & open order');
    await wait(() => guest.querySelector('.guest-menu-preparation-queued'), 'accepted queued status');
    const order = (await api('/orders')).orders.find(o => o.tableId === table.id);
    check(!!order, 'Staff acceptance creates a bill group');
    check((await api('/orders/' + order.id)).order.items.every(i => i.status === 'pending'), 'Acceptance leaves items pending until staff sends them');
    await click(document, 'Send to kitchen');
    await wait(() => guest.querySelector('.guest-menu-preparation-preparing'), 'preparing status');
    check(true, 'Actual kitchen send updates guest preparation status');
    await click(guest, 'Order more');
    await wait(() => guest.querySelector('[aria-label="Your earlier order requests"]'), 'earlier request retained');
    check(guest.querySelector('[aria-label="Your earlier order requests"]').textContent.includes('Preparing'), 'Ordering more retains the earlier preparation status');
    const beforeReload = guest;
    frame.contentWindow.location.reload();
    guest = await wait(() => { const d = guestReady(); return d && d !== beforeReload && d.querySelector('[aria-label="Your earlier order requests"]') ? d : null; }, 'history reload');
    check(guest.querySelector('[aria-label="Your earlier order requests"]').textContent.includes('Preparing'), 'Reload restores earlier request tracking');
    check(guest.querySelectorAll('.guest-service-resolved').length === 2, 'Reload restores handled service receipts');
    guest.querySelector('[aria-label="Add ' + product.name + '"]').click(); await pause();
    await click(guest, 'Submit to staff'); await wait(() => guest.querySelector('.guest-menu-request-pending'), 'second pending');
    await closeDialogs(); await click(document, '\u2190 Back'); await click(document, 'kitchen');
    const ticket = await wait(() => [...document.querySelectorAll('.kitchen-ticket')].find(t => t.textContent.includes(table.name)), 'kitchen ticket');
    await click(ticket, 'Done');
    await wait(() => guest.querySelector('[aria-label="Your earlier order requests"] .guest-menu-preparation-ready'), 'earlier ready update');
    check(guest.querySelector('.guest-menu-request-pending'), 'Earlier kitchen completion does not change the new pending request');
    check(true, 'Kitchen Done reaches an earlier receipt while a newer request awaits acceptance');
    check((await api('/license/devices')).devices.length === devicesBefore, 'Guest interactions consume no staff-device slots');
    check(errors.length === 0, 'Guest flow has no uncaught browser errors');
    window.__m9GuestFlow = { status: 'passed', checks, tableId: table.id, orderId: order.id, guestLink: location.origin + qr.path };
    return window.__m9GuestFlow;
  } catch (error) {
    window.__m9GuestFlow = { status: 'failed', checks, error: String(error), staff: document.body.innerText.slice(-2000), guest: guest.body.innerText.slice(0, 2500) };
    return window.__m9GuestFlow;
  }
})()
