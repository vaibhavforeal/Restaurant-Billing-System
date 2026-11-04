// Hold orders gate. Start `node --import tsx tools/e2e/hold-order-server.mts` (fresh each run), open
// http://127.0.0.1:4153/, sign in as admin (1234), then add this file to the page. Result: window.__holdOrderResult.
// Uses real UI actions; the API only inspects what the hub saved and flips the setting.
(async () => {
  if (location.origin !== 'http://127.0.0.1:4153') throw new Error('Disposable http://127.0.0.1:4153 only');
  const checks = [];
  window.__holdOrderProgress = checks;
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
  const prints = async () => (await (await fetch('/__qa/prints')).json()).prints;
  const dish = (name) => () => [...document.querySelectorAll('button.menu-card')].find((b) => visible(b) && b.textContent.includes(name));
  const confirms = [];
  const realConfirm = window.confirm;
  window.confirm = (message) => { confirms.push(message); return true; };
  const goTables = async () => click(() => document.querySelector('button[aria-label="tables"]:not(:disabled)') || byText('← Tables'), 'Tables');

  try {
    // 1. Dine-in: hold the main, KOT sends only the starter.
    await goTables();
    await click(() => buttons().find((b) => b.closest('*') && b.textContent.includes('Open table') && b.parentElement?.textContent.includes('T3')) || [...document.querySelectorAll('[class*=table]')].filter(visible).find((c) => c.textContent.includes('T3') && c.textContent.includes('Open table'))?.querySelector('button'), 'T3');
    await click(dish('Paneer tikka'), 'Paneer tikka'); await click(dish('Butter chicken'), 'Butter chicken');
    await click(() => buttons().find((b) => b.getAttribute('aria-label') === 'Hold Butter chicken'), 'Hold toggle');
    check(buttons().find((b) => b.getAttribute('aria-label') === 'Release Butter chicken')?.getAttribute('aria-pressed') === 'true', 'cart row shows Held');
    const before = (await prints()).length;
    await click(() => document.querySelector('button[data-shortcut="send_kitchen"]:not(:disabled)'), 'KOT');
    await wait(() => document.body.innerText.includes('Sent to kitchen'), 'KOT sent');
    const kot1 = (await prints()).slice(before);
    check(kot1.length === 1 && kot1[0].includes('Paneer tikka') && !kot1[0].includes('Butter chicken'), 'KOT leaves the held dish out');
    check(!!document.querySelector('.status.held') && !!byText('Fire all held (1)'), 'held dish shows HELD and Fire all held (1)');
    check(document.querySelector('button[data-shortcut="send_kitchen"]').disabled, 'KOT is disabled when only held dishes wait');

    // 2. Billing asks, then fires the held dish.
    await click(() => byText('Preview bill'), 'Preview bill');
    await wait(() => [...document.querySelectorAll('dialog[open]')].some((d) => d.innerText.includes('Issue bill')), 'bill preview');
    check(confirms.at(-1) === 'Send 1 held item to the kitchen and continue?', 'billing asks before firing');
    const kot2 = (await prints()).slice(before + 1);
    check(kot2.length === 1 && kot2[0].includes('Butter chicken'), 'billing fired the held dish');
    await click(() => [...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent.trim() === 'Close'), 'Close billing');

    // 3. Takeaway Hold saves the cart to the hub (any device can resume it).
    await goTables();
    await click(() => byText('Takeaway'), 'Takeaway');
    await click(dish('Butter naan'), 'Butter naan');
    await click(() => buttons().find((b) => b.getAttribute('aria-label') === 'Hold Butter naan'), 'Hold naan');
    await click(() => document.querySelector('button[data-shortcut="hold"]:not(:disabled)'), 'Hold order');
    await wait(() => document.body.innerText.includes('Tables & orders') || document.querySelector('button[aria-label="tables"][disabled]'), 'left the order');
    const { orders } = await api('GET', '/api/orders');
    const parcel = orders.find((o) => o.type === 'parcel' && o.items.some((i) => i.name === 'Butter naan'));
    check(parcel && parcel.items.find((i) => i.name === 'Butter naan').held === true && parcel.items.find((i) => i.name === 'Butter naan').status === 'pending', 'held takeaway is saved on the hub with its held dish');
    check(Object.keys(localStorage).filter((k) => k.startsWith('masalapos.draft.') && k.endsWith(parcel.id)).every((k) => localStorage.getItem(k) === '[]'), 'nothing is left only on this device');

    // 4. Setting off: no Hold controls, Fire still offered for the held dish.
    const { settings } = await api('GET', '/api/settings');
    await api('PUT', '/api/settings', { ...settings, holdOrdersEnabled: false });
    await click(() => [...document.querySelectorAll('button')].filter(visible).find((b) => b.textContent.includes('Takeaway ' + parcel.clientRef.slice(0, 8))), 'open held takeaway');
    await wait(() => !document.querySelector('button[data-shortcut="hold"]'), 'Hold hidden');
    check(!document.querySelector('button.cart-hold'), 'per-dish Hold hidden when the setting is off');
    check(!!document.querySelector('button.saved-item-fire') && !!byText('Fire all held (1)'), 'Fire still offered for a dish held before');
    await api('PUT', '/api/settings', { ...settings, holdOrdersEnabled: true });
    await wait(() => document.querySelector('button[data-shortcut="hold"]'), 'Hold back after turning on');
    check(true, 'Hold returns live when the setting is turned back on');

    window.__holdOrderResult = { status: 'passed', passed: checks.length, checks };
  } catch (error) {
    window.__holdOrderResult = { status: 'failed', error: String(error && error.message || error), checks };
  } finally {
    window.confirm = realConfirm;
  }
  return window.__holdOrderResult;
})();
