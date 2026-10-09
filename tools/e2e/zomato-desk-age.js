// Companion to zomato-desk.js. Run on the disposable Zomato desk fixture (tools/e2e/zomato-desk-server.mts, port 4150), signed in as admin (1234).
// Checks the colour of a Zomato card on the desk (zomato-age-ok / warn / late) against the restaurant's amber and red minutes (defaults 15 and 25).
// It punches in a temporary order AGE-<timestamp> through the API, then back-dates it 30 minutes through the fixture-only hook POST /__e2e/age-order
// (no app code, no waiting). It sets amber/red through the real Marketplace, Zomato card, Settings dialog once, and through the API for the live
// updates (zomato.changed) that must recolour the card without leaving the Tables screen. In `finally` it restores 15/25 and cancels the order,
// so no open Zomato order is left (the cancelled ID stays reserved). The result is window.__zomatoDeskAgeResult (progress in window.__zomatoDeskAgeProgress).
// Never run this against a restaurant database.
(async () => {
  if (location.origin !== 'http://127.0.0.1:4150') throw new Error('Disposable Zomato desk fixture only');
  const checks = [];
  window.__zomatoDeskAgeProgress = checks;
  const check = (ok, name) => { if (!ok) throw new Error(name); checks.push(name); };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const wait = async (predicate, label, ms = 10000) => {
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
  const setValue = (e, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, value); e.dispatchEvent(new Event('input', { bubbles: true })); };
  const navItem = label => [...document.querySelectorAll('.nav-item')].find(e => e.getAttribute('aria-label') === label);
  const goto = async label => { await wait(() => navItem(label) && (!navItem(label).disabled || navItem(label).classList.contains('active')), 'nav ' + label); if (!navItem(label).disabled) navItem(label).click(); await sleep(80); };
  const button = (name, root = document) => [...root.querySelectorAll('button')].find(b => b.textContent.trim() === name);
  const marketplaceCard = name => [...document.querySelectorAll('.marketplace-card')].find(e => e.querySelector('h3').textContent === name);
  const cardFor = id => [...document.querySelectorAll('.zomato-desk-card')].find(c => c.querySelector('.zomato-desk-id')?.textContent === '#' + id);
  const tone = id => ['ok', 'warn', 'late'].filter(t => cardFor(id)?.classList.contains('zomato-age-' + t)).join(',');
  const waitTone = (id, expected, label) => wait(() => tone(id) === expected, label + ' (card is "' + tone(id) + '", expected "' + expected + '")');
  const settings = async () => (await call('GET', '/api/zomato/settings', ownToken)).json;
  const patchAges = async (warnMinutes, lateMinutes) => call('PATCH', '/api/zomato/settings', ownToken, { ...(await settings()), warnMinutes, lateMinutes });
  const id = 'AGE-' + Date.now();
  let orderId = null;

  try {
    const me = (await call('GET', '/api/me', ownToken)).json.user;
    check(me.role === 'admin', 'Signed in as admin');
    const start = await settings();
    check(start.warnMinutes === 15 && start.lateMinutes === 25, 'A fresh restaurant has the default amber 15 and red 25 minutes');

    // ---------- A new order is ok ----------
    const created = await call('POST', '/api/orders', ownToken, { clientRef: 'age-' + Date.now(), type: 'zomato', zomatoOrderId: id });
    check(created.status < 300, 'Punch in the temporary Zomato order ' + id);
    orderId = (await call('GET', '/api/orders', ownToken)).json.orders.find(o => o.zomatoOrderId === id).id;
    await goto('tables'); await wait(() => cardFor(id), 'Zomato card');
    check(tone(id) === 'ok' && /^0 min$/.test(cardFor(id).querySelector('small').textContent), 'A new order at 0 minutes is zomato-age-ok with the default 15/25');

    // ---------- 30 minutes old with the defaults is red ----------
    const aged = await (await nativeFetch('/__e2e/age-order', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orderId, minutes: 30 }) })).json();
    check(aged.changed === 1, 'The fixture back-dates the open order by 30 minutes');
    await goto('home'); await goto('tables'); await wait(() => cardFor(id), 'Zomato card after the order list reloaded');
    await waitTone(id, 'late', 'Aged card with the defaults');
    check(tone(id) === 'late' && cardFor(id).querySelector('small').textContent === '30 min', 'At 30 minutes the card is zomato-age-late with the default 15/25');

    // ---------- Settings dialog: amber 20, red 40 turns it amber ----------
    await goto('marketplace'); await wait(() => marketplaceCard('Zomato') && button('Settings', marketplaceCard('Zomato')), 'Zomato Settings button');
    button('Settings', marketplaceCard('Zomato')).click();
    const dialog = await wait(() => document.querySelector('dialog[open] .zomato-connection') && document.querySelector('dialog[open]'), 'Zomato settings dialog');
    const ageInput = label => [...dialog.querySelectorAll('label')].find(l => l.textContent.startsWith(label))?.querySelector('input');
    await wait(() => ageInput('Amber after (minutes)')?.value === '15' && ageInput('Red after (minutes)')?.value === '25', 'Settings dialog loaded the saved 15/25');
    setValue(ageInput('Amber after (minutes)'), '20'); setValue(ageInput('Red after (minutes)'), '40'); await sleep(60);
    const save = await wait(() => { const b = button('Save connection', dialog); return b && !b.disabled ? b : null; }, 'enabled Save connection');
    save.click();
    await wait(() => /Connection details saved|Verified live receiving/.test(dialog.textContent), 'settings saved message');
    const saved = await settings();
    check(saved.warnMinutes === 20 && saved.lateMinutes === 40, 'Saving the Settings dialog stores amber 20 and red 40');
    document.querySelector('dialog[open] [aria-label="Close Zomato settings"]').click();
    await wait(() => !document.querySelector('dialog[open]'), 'settings dialog closed');
    await goto('tables'); await wait(() => cardFor(id), 'Zomato card');
    await waitTone(id, 'warn', 'Aged card with amber 20 and red 40');
    check(tone(id) === 'warn', 'With amber 20 and red 40 the 30-minute card is zomato-age-warn');

    // ---------- Live: no navigation, no reload ----------
    const marker = document.querySelector('.tables-zomato');
    check((await patchAges(35, 50)).status < 300, 'Admin saves amber 35 and red 50 from another request');
    await waitTone(id, 'ok', 'Card after amber 35 and red 50');
    check(tone(id) === 'ok' && document.querySelector('.tables-zomato') === marker, 'The card turns zomato-age-ok live (zomato.changed) without leaving Tables or reloading');
    check((await patchAges(5, 10)).status < 300, 'Admin saves amber 5 and red 10');
    await waitTone(id, 'late', 'Card after amber 5 and red 10');
    check(tone(id) === 'late', 'With amber 5 and red 10 the card turns zomato-age-late live');

    // ---------- The server refuses red at or before amber ----------
    const equal = await patchAges(30, 30), reversed = await patchAges(30, 20);
    check(equal.status === 400 && equal.json.error === 'Red must be later than amber' && reversed.status === 400 && reversed.json.error === 'Red must be later than amber', 'The server refuses red equal to or earlier than amber with 400 "Red must be later than amber"');
    const unchanged = await settings();
    check(unchanged.warnMinutes === 5 && unchanged.lateMinutes === 10, 'The refused saves leave the stored minutes unchanged');

    // ---------- Restore 15/25 ----------
    check((await patchAges(15, 25)).status < 300, 'Admin restores amber 15 and red 25');
    await waitTone(id, 'late', 'Card after restoring 15/25');
    const restored = await settings();
    check(restored.warnMinutes === 15 && restored.lateMinutes === 25 && tone(id) === 'late', 'The restored 15/25 turn the 30-minute card zomato-age-late again');

    window.__zomatoDeskAgeResult = { status: 'passed', total: checks.length, checks };
    return window.__zomatoDeskAgeResult;
  } catch (error) { window.__zomatoDeskAgeResult = { status: 'failed', checks, error: String(error), tone: tone(id), cardClass: cardFor(id)?.className }; throw error; }
  finally {
    try { await patchAges(15, 25); } catch { /* best effort */ }
    if (orderId) await call('POST', `/api/orders/${orderId}/cancel`, ownToken, { reason: 'Gate cleanup' }).catch(() => {});
  }
})();
