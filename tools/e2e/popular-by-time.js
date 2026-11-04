// Popular-by-time gate. Start `node --import tsx tools/e2e/popular-items-server.mts` (fresh each run), open
// http://127.0.0.1:4155/, sign in as admin (1234), then add this file to the page. Result: window.__popularByTimeResult.
// The fixture sold 20 Paneer tikka 12 hours ago and most Samosas just now. The API only flips the setting.
(async () => {
  if (location.origin !== 'http://127.0.0.1:4155') throw new Error('Disposable http://127.0.0.1:4155 only');
  const checks = [];
  window.__popularByTimeProgress = checks;
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
  const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const { settings } = await api('GET', '/api/settings');

  try {
    check(settings.popularByTimeEnabled === true, 'Match the time of day is on by default');
    await click(() => document.querySelector('button[aria-label="tables"]:not(:disabled)') || byText('← Tables'), 'Tables');
    await click(() => byText('Takeaway'), 'Takeaway');
    await click(() => [...document.querySelectorAll('.category-rail button')].filter(visible).find((b) => b.textContent.trim() === 'Starters'), 'Starters');
    await wait(() => sameList(popularNames(), ['Samosa']) && names()[0] === 'Samosa', 'Samosa popular around now');
    check(true, 'around this hour Samosa is Popular, though Paneer tikka sold more 12 hours ago');

    await api('PUT', '/api/settings', { ...settings, popularByTimeEnabled: false });
    await wait(() => sameList(popularNames(), ['Paneer tikka']) && sameList(names(), ['Paneer tikka', 'Chicken tikka', 'Samosa']), 'Paneer tikka popular all day');
    check(true, 'counting all day, Paneer tikka becomes Popular and first, live');

    await api('PUT', '/api/settings', { ...settings, popularByTimeEnabled: true });
    await wait(() => sameList(popularNames(), ['Samosa']), 'back to the time of day');
    check(true, 'turning it back on returns to the time-of-day best-seller');

    window.__popularByTimeResult = { status: 'passed', passed: checks.length, checks };
  } catch (error) {
    window.__popularByTimeResult = { status: 'failed', error: String(error && error.message || error), checks };
  } finally {
    await api('PUT', '/api/settings', { ...settings, popularByTimeEnabled: true });
  }
  return window.__popularByTimeResult;
})();
