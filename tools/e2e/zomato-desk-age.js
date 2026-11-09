// Companion to zomato-desk.js. Run on the disposable Zomato desk fixture (tools/e2e/zomato-desk-server.mts, port 4150), signed in as admin (admin / admin-password).
// Checks the colour of a Zomato card on the desk (zomato-age-ok / warn / late) against the restaurant's amber and red minutes (defaults 15 and 25).
// It punches in a temporary order AGE-<timestamp> through the API, then back-dates it 30 minutes through the fixture-only hook POST /__e2e/age-order
// (no app code, no waiting). It sets amber/red once through the real Settings → Bill settings card, and through the API for the live
// updates (settings.changed) that must recolour the card without leaving the Tables screen. The minutes apply to every order type. In `finally` it restores 15/25 and cancels the order,
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
  const device = localStorage.getItem('masalapos.device.v1');
  const call = async (method, path, token, body) => {
    const headers = { authorization: 'Bearer ' + token, 'x-masalapos-device': device };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await nativeFetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const ownToken = localStorage.getItem('masalapos.token');
  const setValue = (e, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, value); e.dispatchEvent(new Event('input', { bubbles: true })); };
  const navItem = label => [...document.querySelectorAll('.nav-item')].find(e => e.getAttribute('aria-label') === label);
  const goto = async label => { await wait(() => navItem(label) && (!navItem(label).disabled || navItem(label).classList.contains('active')), 'nav ' + label); if (!navItem(label).disabled) navItem(label).click(); await sleep(80); };
  const button = (name, root = document) => [...root.querySelectorAll('button')].find(b => b.textContent.trim() === name);
  const cardFor = id => [...document.querySelectorAll('.zomato-desk-card')].find(c => c.querySelector('.zomato-desk-id')?.textContent === '#' + id);
  const tone = id => ['ok', 'warn', 'late'].filter(t => cardFor(id)?.classList.contains('zomato-age-' + t)).join(',');
  const waitTone = (id, expected, label) => wait(() => tone(id) === expected, label + ' (card is "' + tone(id) + '", expected "' + expected + '")');
  const allSettings = async () => (await call('GET', '/api/settings', ownToken)).json.settings;
  const settings = async () => { const s = await allSettings(); return { warnMinutes: s.orderWarnMinutes, lateMinutes: s.orderLateMinutes }; };
  const patchAges = async (orderWarnMinutes, orderLateMinutes) => call('PUT', '/api/settings', ownToken, { ...(await allSettings()), orderWarnMinutes, orderLateMinutes });
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

    // ---------- Settings → Bill settings: amber 20, red 40 turns it amber ----------
    await goto('settings');
    const billCard = await wait(() => document.querySelector('[data-section="bill"]'), 'Bill settings card');
    billCard.click();
    const form = await wait(() => document.querySelector('.bill-settings-form'), 'Bill settings form');
    const ageInput = label => [...form.querySelectorAll('label')].find(l => l.textContent.trim().startsWith(label))?.querySelector('input');
    await wait(() => ageInput('Order turns amber after (minutes)')?.value === '15' && ageInput('Red after (minutes)')?.value === '25', 'Bill settings loaded the saved 15/25');
    setValue(ageInput('Order turns amber after (minutes)'), '20'); setValue(ageInput('Red after (minutes)'), '40'); await sleep(60);
    const save = await wait(() => { const b = button('Save', form); return b && !b.disabled ? b : null; }, 'enabled Save');
    save.click();
    await wait(() => /Saved ✓/.test(form.textContent), 'settings saved message');
    const saved = await settings();
    check(saved.warnMinutes === 20 && saved.lateMinutes === 40, 'Saving Bill settings stores amber 20 and red 40');
    await goto('tables'); await wait(() => cardFor(id), 'Zomato card');
    await waitTone(id, 'warn', 'Aged card with amber 20 and red 40');
    check(tone(id) === 'warn', 'With amber 20 and red 40 the 30-minute card is zomato-age-warn');

    // ---------- Live: no navigation, no reload ----------
    const marker = document.querySelector('.tables-zomato');
    check((await patchAges(35, 50)).status < 300, 'Admin saves amber 35 and red 50 from another request');
    await waitTone(id, 'ok', 'Card after amber 35 and red 50');
    check(tone(id) === 'ok' && document.querySelector('.tables-zomato') === marker, 'The card turns zomato-age-ok live (settings.changed) without leaving Tables or reloading');
    check((await patchAges(5, 10)).status < 300, 'Admin saves amber 5 and red 10');
    await waitTone(id, 'late', 'Card after amber 5 and red 10');
    check(tone(id) === 'late', 'With amber 5 and red 10 the card turns zomato-age-late live');

    // ---------- The server refuses red at or before amber ----------
    const equal = await patchAges(30, 30), reversed = await patchAges(30, 20);
    const refusal = r => r.json?.issues?.[0]?.message ?? r.json?.error;
    check(equal.status === 400 && refusal(equal) === 'Red must be later than amber' && reversed.status === 400 && refusal(reversed) === 'Red must be later than amber', 'The server refuses red equal to or earlier than amber with 400 "Red must be later than amber"');
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
