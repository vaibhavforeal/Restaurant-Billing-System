// Companion to zomato-desk.js. Run on the disposable Zomato desk fixture (tools/e2e/zomato-desk-server.mts, port 4150)
// AFTER signing in through the app as the waiter (PIN 3456), and again after signing out and in as the cashier (PIN 2345).
// The script detects the role from /api/me. Through the API it punches in a temporary Zomato order as admin first, so a
// hidden Zomato section cannot pass just because there is nothing to show, and it cancels that order again in `finally`.
// The result is window.__zomatoDeskRolesResult (progress in window.__zomatoDeskRolesProgress). It is independent of
// zomato-desk.js (it leaves no open Zomato order), but a cancelled ROLE-* ID stays reserved. Never run it against a restaurant database.
(async () => {
  if (location.origin !== 'http://127.0.0.1:4150') throw new Error('Disposable Zomato desk fixture only');
  const checks = [];
  window.__zomatoDeskRolesProgress = checks;
  const check = (ok, name) => { if (!ok) throw new Error(name); checks.push(name); };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const wait = async (predicate, label, ms = 12000) => {
    const until = Date.now() + ms;
    for (;;) { const value = await predicate(); if (value) return value; if (Date.now() > until) throw new Error('Timed out: ' + label); await sleep(40); }
  };
  const nativeFetch = window.fetch;
  const device = localStorage.getItem('forkflow.device.v1');
  const call = async (method, path, token, body) => {
    const headers = { authorization: 'Bearer ' + token, 'x-forkflow-device': device };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await nativeFetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const ownToken = localStorage.getItem('forkflow.token');
  const login = async pin => (await (await nativeFetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forkflow-device': device }, body: JSON.stringify({ pin }) })).json()).token;
  const navItem = label => [...document.querySelectorAll('.nav-item')].find(e => e.getAttribute('aria-label') === label);
  const newButtons = () => [...document.querySelectorAll('button')].filter(b => /^\+?\s*New$/.test(b.textContent.trim()) && (b.classList.contains('zomato-desk-new') || b.closest('.tables-zomato') || /zomato/i.test(b.getAttribute('aria-label') ?? '')));
  const zomatoHeadings = () => [...document.querySelectorAll('h1, h2, h3, h4, [role="heading"]')].filter(h => /zomato/i.test(h.textContent));
  const zomatoUi = () => ({ section: !!document.querySelector('.tables-zomato, .zomato-desk, #zomato-list'), headings: zomatoHeadings().length, newButtons: newButtons().length, text: /zomato/i.test(document.body.innerText) });
  const money = n => '₹' + (n / 100).toFixed(2);

  const me = (await call('GET', '/api/me', ownToken)).json?.user;
  const id = 'ROLE-' + Date.now().toString(36).toUpperCase();
  let adminToken = null, orderId = null;
  try {
    adminToken = await login('1234');
    const products = (await call('GET', '/api/products', adminToken)).json.products;
    const product = products.find(p => p.name === 'Paneer tikka');
    const created = await call('POST', '/api/orders', adminToken, { clientRef: 'roles-' + id, type: 'zomato', zomatoOrderId: id });
    check(created.status < 300 && !!created.json?.order?.id, 'An open Zomato order is punched in through the API as admin');
    orderId = created.json.order.id;
    const added = await call('POST', `/api/orders/${orderId}/items`, adminToken, { items: [{ clientRef: 'roles-item-' + id, productId: product.id, qty: 1 }] });
    check(added.status < 300, 'The Zomato order has an item');
    const openForAdmin = (await call('GET', '/api/orders', adminToken)).json.orders.filter(o => o.type === 'zomato' && o.status === 'open');
    check(openForAdmin.some(o => o.zomatoOrderId === id), 'The Zomato order is open on the server');
    await sleep(2500); // let the order events and the periodic refresh reach the signed-in screen

    if (me.role === 'waiter') {
      check(location.pathname.startsWith('/captain/'), 'The waiter is in the Captain app (' + location.pathname + ')');
      const read = await call('GET', '/api/orders', ownToken);
      let dataNote;
      if (read.status === 200) {
        check(read.json.orders.some(o => o.type === 'zomato' && o.zomatoOrderId === id), 'The server still returns the open Zomato order to the waiter, so the section is hidden in the UI, not for lack of data');
        dataNote = 'the waiter can read GET /api/orders and it contains the open Zomato order';
      } else {
        check(read.status === 403, 'The waiter cannot read orders (' + read.status + '), so the UI check below does not rely on that data');
        dataNote = 'the waiter cannot read GET /api/orders (' + read.status + ')';
      }
      const landing = zomatoUi();
      check(!landing.section && landing.headings === 0 && landing.newButtons === 0 && !landing.text, 'The waiter\'s landing screen has no Zomato section, heading, + New button or Zomato text');
      // Any Tables screen the waiter can open: the Captain app opens on its tables list; use its nav and refresh paths too.
      const tablesNav = navItem('tables');
      if (tablesNav && !tablesNav.disabled) { tablesNav.click(); await sleep(400); }
      const refresh = [...document.querySelectorAll('button')].find(b => /^(refresh|retry|reload)$/i.test(b.textContent.trim()));
      if (refresh && !refresh.disabled) { refresh.click(); await sleep(800); }
      const tables = zomatoUi();
      check(!tables.section && tables.headings === 0 && tables.newButtons === 0 && !tables.text, 'The waiter\'s Tables screen, after a refresh, still has no Zomato section, heading, + New button or Zomato text');
      check(!document.querySelector('.tables-zomato') && !document.querySelector('.zomato-desk-new') && !document.querySelector('.zomato-desk-card'), 'No .tables-zomato, + New or Zomato card element exists (' + dataNote + ')');
    } else if (me.role === 'cashier') {
      await wait(() => navItem('tables'), 'tables nav');
      if (!navItem('tables').disabled) navItem('tables').click();
      const section = await wait(() => document.querySelector('.tables-zomato'), 'Zomato section');
      check(section.querySelector('h3')?.textContent === 'Zomato' && !!section.querySelector('.zomato-desk-new') && section.querySelector('.zomato-desk-new').textContent === '+ New' && !section.querySelector('.zomato-desk-new').disabled, 'The cashier sees the Zomato section with an enabled + New button');
      const card = await wait(() => [...document.querySelectorAll('.tables-zomato .zomato-desk-card')].find(c => c.querySelector('.zomato-desk-id')?.textContent === '#' + id), 'Zomato card');
      check(card.querySelector('.zomato-desk-pill').textContent === 'New' && card.textContent.includes(money(24000)) && !!card.querySelector('.zomato-desk-action'), 'The cashier sees the open order card (#' + id + ') with status, total and its next-step button');
      check(section.querySelector('.panel-title span').textContent === String(document.querySelectorAll('.tables-zomato .zomato-desk-card').length) && !document.querySelector('.zomato-desk-empty'), 'The section count matches the open Zomato cards and is not empty');
    } else throw new Error('Run as the waiter (3456) or the cashier (2345)');

    window.__zomatoDeskRolesResult = { status: 'passed', role: me.role, total: checks.length, checks };
    return window.__zomatoDeskRolesResult;
  } catch (error) { window.__zomatoDeskRolesResult = { status: 'failed', role: me?.role, checks, error: String(error) }; throw error; }
  finally {
    if (adminToken && orderId) { try { await call('POST', `/api/orders/${orderId}/cancel`, adminToken, { reason: 'Roles gate cleanup' }); } catch { /* fixture already stopped */ } }
  }
})();
