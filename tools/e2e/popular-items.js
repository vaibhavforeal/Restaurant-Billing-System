// Popular items gate. Start `node --import tsx tools/e2e/popular-items-server.mts` (fresh each run), open
// http://127.0.0.1:4155/, sign in as admin (1234), then add this file to the page. Result: window.__popularItemsResult.
// Drives the real order screen; the QR table menu is opened in a same-origin iframe. The API only flips the setting.
(async () => {
  if (location.origin !== 'http://127.0.0.1:4155') throw new Error('Disposable http://127.0.0.1:4155 only');
  const checks = [];
  window.__popularItemsProgress = checks;
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
  const cards = () => [...document.querySelectorAll('.menu-grid button.menu-card')].filter(visible);
  const names = () => cards().map((c) => c.querySelector('.menu-card-name').firstChild.textContent.trim());
  const popularNames = () => cards().filter((c) => c.querySelector('.menu-popular-label')).map((c) => c.querySelector('.menu-card-name').firstChild.textContent.trim());
  const category = (name) => () => [...document.querySelectorAll('.category-rail button')].filter(visible).find((b) => b.textContent.trim() === name);
  const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  let frame = null;
  const { settings } = await api('GET', '/api/settings');

  try {
    // 1. Staff order screen: each category's best-seller is badged and first; the rest keep A-Z order.
    await click(() => document.querySelector('button[aria-label="tables"]:not(:disabled)') || byText('← Tables'), 'Tables');
    await click(() => byText('Takeaway'), 'Takeaway');
    await click(category('Starters'), 'Starters');
    await wait(() => sameList(names(), ['Samosa', 'Chicken tikka', 'Paneer tikka']), 'Starters with Samosa first');
    check(sameList(popularNames(), ['Samosa']), 'Starters: Samosa is Popular and first, the rest stay A-Z');
    await click(category('Mains'), 'Mains');
    await wait(() => sameList(names(), ['Biryani', 'Dal tadka']), 'Mains list');
    check(sameList(popularNames(), ['Biryani']), 'Mains: Biryani is Popular');
    await click(category('Drinks'), 'Drinks');
    await wait(() => sameList(names(), ['Lassi']), 'Drinks list');
    check(popularNames().length === 0, 'a category with one dish gets no badge');
    await click(category('All items'), 'All items');
    await wait(() => cards().length === 6, 'All items list');
    check(sameList(names().slice(0, 2), ['Biryani', 'Samosa']) && sameList(popularNames(), ['Biryani', 'Samosa']), 'All items lists the best-sellers first');

    // 2. QR table menu shows the same badges.
    const { path } = await (await fetch('/__qa/qr')).json();
    frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;left:-2000px;top:0;width:1000px;height:900px';
    frame.src = path;
    document.body.append(frame);
    const guest = () => [...(frame.contentDocument?.querySelectorAll('.guest-menu-product') ?? [])];
    const guestPopular = () => guest().filter((p) => p.querySelector('.guest-menu-popular')).map((p) => p.querySelector('h3').textContent.trim());
    await wait(() => guest().length === 6, 'guest menu');
    check(sameList(guest().slice(0, 2).map((p) => p.querySelector('h3').textContent.trim()), ['Biryani', 'Samosa']) && sameList(guestPopular(), ['Biryani', 'Samosa']), 'QR menu badges the best-sellers and shows them first');

    // 3. Setting off: staff badges go live, the QR menu shows none on its next load.
    await api('PUT', '/api/settings', { ...settings, popularItemsEnabled: false });
    await wait(() => cards().length === 6 && popularNames().length === 0, 'staff badges removed');
    check(names()[0] === 'Biryani' && names()[1] === 'Chicken tikka', 'staff menu returns to A-Z when the setting is off');
    frame.contentWindow.location.reload();
    await pause(500);
    await wait(() => guest().length === 6, 'guest menu reloaded');
    check(guestPopular().length === 0, 'QR menu shows no badges when the setting is off');

    window.__popularItemsResult = { status: 'passed', passed: checks.length, checks };
  } catch (error) {
    window.__popularItemsResult = { status: 'failed', error: String(error && error.message || error), checks };
  } finally {
    frame?.remove();
    await api('PUT', '/api/settings', { ...settings, popularItemsEnabled: true });
  }
  return window.__popularItemsResult;
})();
