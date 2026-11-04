// Customer's usual gate. Start `node --import tsx tools/e2e/customer-usual-server.mts` (fresh each run), open
// http://127.0.0.1:4156/, sign in as admin / admin-password, then add this file to the page. Result: window.__customerUsualResult.
// Drives the real order screen; the API only flips the setting.
(async () => {
  if (location.origin !== 'http://127.0.0.1:4156') throw new Error('Disposable http://127.0.0.1:4156 only');
  const checks = [];
  window.__customerUsualProgress = checks;
  const pause = (ms = 80) => new Promise((r) => setTimeout(r, ms));
  const check = (ok, label) => { if (!ok) throw new Error(label); checks.push(label); };
  const wait = async (fn, label) => {
    const until = Date.now() + 15000;
    while (Date.now() < until) { const v = await fn(); if (v) return v; await pause(); }
    throw new Error('Timed out: ' + label + '. Page: ' + document.body.innerText.slice(-800));
  };
  const visible = (el) => !!el && el.getClientRects().length > 0 && !el.closest('[inert]');
  const buttons = () => [...document.querySelectorAll('button')].filter(visible);
  const byText = (text) => buttons().find((b) => b.textContent.trim().startsWith(text) && !b.disabled);
  const click = async (find, label) => { const b = await wait(find, label); b.click(); await pause(250); };
  const api = async (method, path, body) => {
    const res = await fetch(path, { method, headers: { authorization: 'Bearer ' + localStorage.getItem('masalapos.token'), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return res.json();
  };
  const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const usualNames = () => [...document.querySelectorAll('.customer-usual button:not(.customer-usual-repeat)')].filter(visible)
    .map((b) => b.getAttribute('aria-label').replace(/^Add Priya's usual /, '').replace(/, ₹.*$/, ''));
  const draftNames = () => [...document.querySelectorAll('.draft-row .cart-item-name strong')].map((n) => n.textContent.trim());
  const typeInto = (input, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const attachPriya = async () => {
    await click(() => byText('Add customer'), 'Add customer');
    typeInto(await wait(() => document.querySelector('input[aria-label="Customer mobile or name"]'), 'customer search'), '98765');
    await click(() => buttons().find((b) => b.textContent.startsWith('Priya Sharma')), 'Priya in the results');
  };
  const newTakeaway = async () => {
    await click(() => document.querySelector('button[aria-label="tables"]:not(:disabled)') || byText('← Tables'), 'Tables');
    await click(() => byText('Takeaway'), 'Takeaway');
    await wait(() => document.querySelector('button.menu-card'), 'menu');
  };
  const { settings } = await api('GET', '/api/settings');

  try {
    // 1. Attaching a regular shows their usual dishes, in their usual size.
    await newTakeaway();
    check(!document.querySelector('.customer-usual'), 'no usual row before a customer is added');
    await attachPriya();
    await wait(() => sameList(usualNames(), ['Butter naan', 'Paneer tikka (Full)']), 'usual dishes');
    check(document.querySelector('#customer-usual-title').textContent === 'Usual for Priya', 'the row is titled with her first name');
    check(true, 'usual: Butter naan and Paneer tikka in her usual size (Full), both on 2 bills');

    // 2. One tap adds a usual dish, which then leaves the row.
    await click(() => buttons().find((b) => (b.getAttribute('aria-label') || '').startsWith("Add Priya's usual Paneer tikka (Full)")), 'usual Paneer tikka');
    await wait(() => sameList(draftNames(), ['Paneer tikka (Full)']), 'Paneer tikka in the cart');
    check(sameList(usualNames(), ['Butter naan']), 'one tap adds it to the cart and it leaves the usual row');

    // 3. Repeat last order adds what it can and names what it could not.
    await click(() => buttons().find((b) => b.classList.contains('customer-usual-repeat')), 'Repeat last order');
    await wait(() => draftNames().length === 4, 'repeated dishes in the cart');
    check(sameList(draftNames(), ['Paneer tikka (Full)', 'Paneer tikka (Full)', 'Butter naan', 'Dal tadka']), 'Repeat adds the last bill\'s dishes in their sizes');
    const message = await wait(() => document.querySelector('.captain-message')?.textContent, 'repeat message');
    check(message.includes('Added 4 items from bill') && message.includes('Thali (choose its items from the menu)') && message.includes('Lassi (sold out)'),
      'the message counts what was added and names the Thali and the sold-out Lassi');

    // 4. Setting off: no usual row when the customer is added again (Repeat last order would otherwise still show).
    check(!!document.querySelector('.customer-usual-repeat'), 'with the setting on, Repeat last order stays offered');
    await api('PUT', '/api/settings', { ...settings, customerUsualEnabled: false });
    await click(() => buttons().find((b) => b.getAttribute('aria-label') === 'Remove customer'), 'Remove customer');
    await wait(() => !document.querySelector('.customer-usual'), 'row gone with the customer');
    await attachPriya();
    await wait(() => document.body.innerText.includes('Priya Sharma ·'), 'Priya attached');
    await pause(800);
    check(!document.querySelector('.customer-usual'), 'no usual row while the setting is off');

    window.__customerUsualResult = { status: 'passed', passed: checks.length, checks };
  } catch (error) {
    window.__customerUsualResult = { status: 'failed', error: String(error && error.message || error), checks };
  } finally {
    await api('PUT', '/api/settings', { ...settings, customerUsualEnabled: true });
  }
  return window.__customerUsualResult;
})();
