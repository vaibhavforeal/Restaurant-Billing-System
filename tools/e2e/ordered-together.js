// Ordered-together gate. Start `node --import tsx tools/e2e/popular-items-server.mts` (fresh each run), open
// http://127.0.0.1:4155/, sign in as admin (1234), then add this file to the page. Result: window.__orderedTogetherResult.
// Drives the real order screen and the QR table menu (in a same-origin iframe). The API only flips the setting.
(async () => {
  if (location.origin !== 'http://127.0.0.1:4155') throw new Error('Disposable http://127.0.0.1:4155 only');
  const checks = [];
  window.__orderedTogetherProgress = checks;
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
  const staffSuggestions = () => [...document.querySelectorAll('.cart-suggestions button')].filter(visible)
    .map((b) => b.getAttribute('aria-label').replace(/^Also add /, '').replace(/, ₹.*$/, ''));
  const draftNames = () => [...document.querySelectorAll('.draft-row .cart-item-name strong')].map((n) => n.textContent.trim());
  let frame = null;
  const { settings } = await api('GET', '/api/settings');

  try {
    // 1. Staff cart: Biryani suggests Lassi and Samosa; adding Lassi drops the drinks suggestion.
    await click(() => document.querySelector('button[aria-label="tables"]:not(:disabled)') || byText('← Tables'), 'Tables');
    await click(() => byText('Takeaway'), 'Takeaway');
    await wait(() => document.querySelector('button.menu-card') && !document.querySelector('.cart-suggestions'), 'empty cart');
    check(true, 'an empty cart shows no suggestions');
    await click(() => [...document.querySelectorAll('.category-rail button')].filter(visible).find((b) => b.textContent.trim() === 'All items'), 'All items');
    await click(() => [...document.querySelectorAll('button.menu-card')].find((b) => visible(b) && b.textContent.includes('Biryani')), 'Biryani card');
    await wait(() => sameList(staffSuggestions(), ['Lassi', 'Samosa']), 'staff suggestions for Biryani');
    check(true, 'staff cart suggests Lassi and Samosa for Biryani');
    await click(() => [...document.querySelectorAll('.cart-suggestions button')].find((b) => b.getAttribute('aria-label').startsWith('Also add Lassi')), 'Also add Lassi');
    await wait(() => sameList(draftNames(), ['Biryani', 'Lassi']), 'Lassi in the cart');
    check(sameList(staffSuggestions(), ['Samosa']), 'one tap adds Lassi to the cart, and the drinks suggestion goes');

    // 2. QR table menu: the same suggestions in the guest's request.
    const { path } = await (await fetch('/__qa/qr')).json();
    frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;left:-2000px;top:0;width:1000px;height:900px';
    frame.src = path;
    document.body.append(frame);
    const doc = () => frame.contentDocument;
    const guestSuggestions = () => [...(doc()?.querySelectorAll('.guest-menu-suggestions li > span') ?? [])].map((n) => n.firstChild.textContent.trim());
    const guestCart = () => [...(doc()?.querySelectorAll('.guest-menu-cart-items h3') ?? [])].map((n) => n.textContent.trim());
    const guestButton = (label) => () => [...(doc()?.querySelectorAll('button') ?? [])].find((b) => b.getAttribute('aria-label') === label && !b.disabled);
    await wait(() => doc()?.querySelectorAll('.guest-menu-product').length === 6, 'guest menu');
    await click(guestButton('Add Biryani'), 'guest Add Biryani');
    await wait(() => sameList(guestSuggestions(), ['Lassi', 'Samosa']), 'guest suggestions');
    check(true, 'QR request suggests Lassi and Samosa for Biryani');
    await click(guestButton('Also add Samosa'), 'guest Also add Samosa');
    await wait(() => sameList(guestCart(), ['Biryani', 'Samosa']), 'Samosa in the guest request');
    check(sameList(guestSuggestions(), ['Lassi']), 'guest one-tap add works and the starters suggestion goes');

    // 3. Setting off: the staff row goes live; the QR request shows none on its next load.
    await api('PUT', '/api/settings', { ...settings, orderedTogetherEnabled: false });
    await wait(() => !document.querySelector('.cart-suggestions'), 'staff suggestions removed');
    check(true, 'staff suggestions disappear when the setting is turned off');
    frame.contentWindow.location.reload();
    await pause(500);
    await wait(() => doc()?.querySelectorAll('.guest-menu-product').length === 6 && guestCart().length === 2, 'guest menu reloaded');
    check(guestSuggestions().length === 0, 'QR request shows no suggestions when the setting is off');

    window.__orderedTogetherResult = { status: 'passed', passed: checks.length, checks };
  } catch (error) {
    window.__orderedTogetherResult = { status: 'failed', error: String(error && error.message || error), checks };
  } finally {
    frame?.remove();
    await api('PUT', '/api/settings', { ...settings, orderedTogetherEnabled: true });
  }
  return window.__orderedTogetherResult;
})();
