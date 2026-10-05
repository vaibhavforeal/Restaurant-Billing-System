// Follow m8-qr.js in the same registered browser on the disposable QA server.
(async () => {
  if (location.origin !== 'http://127.0.0.1:4117' || window.__m8Report?.status !== 'passed') throw new Error('Run m8-qr.js first');
  const { tableId, orderId, link } = window.__m8Report;
  const checks = [], originalConfirm = window.confirm;
  const check = (ok, label) => { if (!ok) throw new Error(label); checks.push(label); };
  const pause = (ms = 70) => new Promise((r) => setTimeout(r, ms));
  const wait = async (fn, name) => { const end = Date.now() + 10000; while (Date.now() < end) { const x = fn(); if (x) return x; await pause(); } throw new Error('Timed out: ' + name); };
  const activeModal = (doc) => [...doc.querySelectorAll('dialog[open]')].reverse().find((dialog) => dialog.matches(':modal'));
  const available = (element) => {
    if (!element?.isConnected || element.closest('[hidden],[inert]') || !element.getClientRects().length) return false;
    const doc = element.ownerDocument, modal = activeModal(doc), style = doc.defaultView.getComputedStyle(element);
    if ((modal && !modal.contains(element)) || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    const frame = doc.defaultView.frameElement;
    return !frame || available(frame);
  };
  const btn = (doc, name) => [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === name && available(b));
  const click = async (doc, name) => { const b = await wait(() => { const b = btn(doc, name); return b && !b.disabled ? b : null; }, name); b.click(); await pause(); };
  const closeDialogs = async () => {
    let modal;
    while ((modal = activeModal(document))) {
      await click(modal, 'Close');
      await wait(() => !modal.open, 'staff dialog closed');
    }
  };
  const openStaffDialog = async (label) => { await closeDialogs(); await click(document, label); return wait(() => activeModal(document), label + ' dialog'); };
  const fill = async (doc, name, value) => {
    const input = await wait(() => { const el = [...doc.querySelectorAll('label')].find((l) => l.textContent.trim().startsWith(name) && available(l))?.querySelector('select,textarea,input'); return el && !el.disabled ? el : null; }, name);
    const view = doc.defaultView, proto = input.tagName === 'SELECT' ? view.HTMLSelectElement.prototype : input.tagName === 'TEXTAREA' ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value);
    input.dispatchEvent(new view.Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); await pause();
  };
  const headers = { authorization: `Bearer ${localStorage.getItem('forkflow.token')}`, 'x-forkflow-device': localStorage.getItem('forkflow.device.v1'), 'content-type': 'application/json' };
  const api = async (path, method = 'GET', body) => {
    const res = await fetch('/api' + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await res.json(); if (!res.ok) throw new Error(JSON.stringify(value)); return value;
  };
  const iframe = document.createElement('iframe'); iframe.src = link;
  iframe.style.cssText = 'position:fixed;right:8px;bottom:8px;width:390px;height:500px;z-index:9000;background:white';
  document.body.append(iframe);
  let chai;
  try {
    await closeDialogs();
    const guest = await wait(() => iframe.contentDocument?.querySelector('.guest-menu-request-accepted') ? iframe.contentDocument : null, 'saved accepted receipt');
    check(true, 'Reload restores the accepted request receipt');
    await click(guest, 'Order more');
    await wait(() => guest.querySelector('[aria-label="Add Masala chai"]') && !guest.querySelector('[aria-label="Add Masala chai"]').disabled, 'next request');
    guest.querySelector('[aria-label="Add Masala chai"]').click(); await pause();
    chai = (await api('/products')).products.find((p) => p.name === 'Masala chai');
    await api('/products/' + chai.id, 'PATCH', { pricePaise: chai.pricePaise + 1000 });
    await click(guest, 'Submit to staff');
    await wait(() => btn(guest, 'Reload menu and review'), 'stale menu response');
    check(!guest.querySelector('[aria-label="Request status"]') && btn(guest, 'Submit to staff').disabled, 'Changed prices prevent submission and require explicit review');
    await click(guest, 'Reload menu and review');
    await wait(() => guest.querySelector('.guest-menu-review input'), 'review checkbox');
    check(btn(guest, 'Submit to staff').disabled && guest.querySelector('.guest-menu-cart-total').textContent.includes('50.00'), 'Updated cart shows the current price before resubmission');
    guest.querySelector('.guest-menu-review input').click(); await pause();
    await click(guest, 'Submit to staff');
    await wait(() => guest.querySelector('.guest-menu-request-pending'), 'pending second request');
    await closeDialogs(); await click(document, '\u2190 Back'); await openStaffDialog('Review requests'); await click(document, 'Refresh requests');
    const tableName = (await api('/tables')).tables.find((t) => t.id === tableId).name;
    await fill(document, 'Bill group for ' + tableName, orderId);
    await click(document, 'Accept & open order');
    await wait(() => btn(document, 'Send to kitchen'), 'existing order opened');
    const order = (await api('/orders/' + orderId)).order;
    check(order.items.length === 2 && order.items.some((i) => i.productId === chai.id && i.status === 'pending'), 'Staff can append the reviewed request to the explicitly selected existing bill');
    check((await api('/orders')).orders.filter((o) => o.tableId === tableId).length === 1, 'Existing-bill acceptance creates no extra bill group');
    await wait(() => guest.querySelector('.guest-menu-request-accepted'), 'second acceptance');
    await click(guest, 'Order more');
    await wait(() => guest.querySelector('[aria-label="Add Masala chai"]') && !guest.querySelector('[aria-label="Add Masala chai"]').disabled, 'third request');
    guest.querySelector('[aria-label="Add Masala chai"]').click(); await pause(); await click(guest, 'Submit to staff');
    await wait(() => guest.querySelector('.guest-menu-request-pending'), 'third pending');
    await closeDialogs(); await click(document, '\u2190 Back'); await openStaffDialog('Review requests'); await click(document, 'Refresh requests');
    await click(document, 'Reject\u2026'); await fill(document, 'Reason shown to the guest', 'Chai is sold out for today'); await click(document, 'Reject request');
    await wait(() => guest.querySelector('.guest-menu-request-rejected'), 'guest rejection');
    check(guest.body.innerText.includes('Chai is sold out for today') && (await api('/orders/' + orderId)).order.items.length === 2, 'Guest sees the staff rejection reason and rejected items never enter the order');
    await openStaffDialog('Table QR codes'); await fill(document, 'Table', tableId);
    await wait(() => document.querySelector('.qr-code-preview img'), 'QR ready for rotation');
    const oldToken = new URL(link).hash.slice(1);
    window.confirm = () => true; await click(document, 'Replace QR code');
    await wait(() => { const input = [...document.querySelectorAll('label')].find((l) => l.textContent === 'Guest menu link')?.querySelector('input'); return input?.value && new URL(input.value).hash.slice(1) !== oldToken; }, 'rotated QR image');
    const oldMenu = await fetch('/api/guest/menu', { headers: { 'x-qr-token': oldToken } });
    check(oldMenu.status === 404, 'Rotating the QR invalidates the old printed link');
    iframe.contentWindow.location.reload();
    await wait(() => iframe.contentDocument?.body.innerText.includes('This table menu is unavailable'), 'old QR unavailable');
    check(iframe.contentDocument.querySelector('.guest-menu-request-rejected'), 'Saved receipt remains visible after QR rotation');
    await click(document, 'Disable QR code');
    await wait(() => btn(document, 'Enable QR code'), 'QR disabled');
    check(!document.querySelector('.qr-code-preview'), 'Disabling a table removes its printable QR preview');
    window.__m8ReviewReport = { status: 'passed', checks }; return window.__m8ReviewReport;
  } catch (e) { window.__m8ReviewReport = { status: 'failed', checks, error: String(e) }; throw e; }
  finally { iframe.remove(); window.confirm = originalConfirm; if (chai) await api('/products/' + chai.id, 'PATCH', { pricePaise: chai.pricePaise }); }
})()
