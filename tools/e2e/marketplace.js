// Run with agent-browser eval --stdin on the disposable sales-dashboard fixture (tools/e2e/sales-dashboard-server.mts),
// signed in as admin (1234) OR as cashier (2345): the script detects the role and runs that role's checks.
// The fixture starts with Zomato OFF in the Marketplace and one open Zomato order (#000201). Every run ends with
// Zomato OFF again, so the gate can be repeated. Never run this against a restaurant database.
(async () => {
  if (location.origin !== 'http://127.0.0.1:4145') throw new Error('Disposable sales fixture only');
  const checks = [];
  const check = (ok, name) => { if (!ok) throw new Error(name); checks.push(name); window.__marketplaceProgress = checks; };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const wait = async (predicate, label = String(predicate)) => {
    const until = Date.now() + 8000;
    while (!predicate()) { if (Date.now() > until) throw new Error('Timed out: ' + label); await sleep(40); }
  };
  const nativeFetch = window.fetch;
  const device = localStorage.getItem('forkflow.device.v1');
  const call = async (method, path, token, body, rawBody) => {
    const headers = { authorization: 'Bearer ' + token, 'x-forkflow-device': device };
    if (body !== undefined || rawBody !== undefined) headers['content-type'] = 'application/json';
    const r = await nativeFetch(path, { method, headers, body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)) });
    return { status: r.status, cache: r.headers.get('cache-control'), json: await r.json().catch(() => null) };
  };
  const ownToken = localStorage.getItem('forkflow.token');
  // A second counter: an admin session obtained through the API, never touching this browser's own session.
  const login = async pin => (await (await nativeFetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forkflow-device': device }, body: JSON.stringify({ pin }) })).json()).token;
  const adminToken = await login('1234');
  const setZomato = async enabled => { const r = await call('PATCH', '/api/integrations/zomato', adminToken, { enabled }); if (r.status !== 200) throw new Error('Fixture PATCH failed: ' + r.status); };
  const setKds = async enabled => { const r = await call('PATCH', '/api/integrations/kds', adminToken, { enabled }); if (r.status !== 200) throw new Error('Fixture KDS PATCH failed: ' + r.status); };
  const me = (await call('GET', '/api/me', ownToken)).json.user;

  const navItem = label => [...document.querySelectorAll('.nav-item')].find(e => e.getAttribute('aria-label') === label);
  const goto = async label => { await wait(() => navItem(label) && (!navItem(label).disabled || navItem(label).classList.contains('active')), 'nav ' + label); if (!navItem(label).disabled) navItem(label).click(); await sleep(60); };
  const heading = () => document.querySelector('.workspace h2')?.textContent;
  // The Zomato page is gone: reconciliation is a Reports tab and connection settings live on the Marketplace card (Settings).
  const zomatoTab = () => [...document.querySelectorAll('.sales-presets button')].find(b => b.textContent === 'Zomato reconciliation');
  const settingsButton = () => [...(card('Zomato')?.querySelectorAll('button') ?? [])].find(b => b.textContent === 'Settings');
  const card = name => [...document.querySelectorAll('.marketplace-card')].find(e => e.querySelector('h3').textContent === name);
  const sw = name => card(name)?.querySelector('[role="switch"]');
  const pill = name => card(name)?.querySelector('.marketplace-pill').textContent;
  const alertsText = () => document.querySelector('.dash-alerts')?.textContent ?? '';
  const homeReady = () => document.querySelector('.dash-alerts') && document.querySelector('.dash-channel-total .dash-channel-amount')?.textContent !== '—';
  const rows = () => [...document.querySelectorAll('.dash-alert-row')];
  window.__marketplaceNoReload = true; // survives only while the page is not reloaded

  // Count PATCHes (optionally slowed or failed) made by the UI.
  let patches = 0, slowMs = 0, failNext = false;
  window.fetch = async (path, init) => {
    if (String(path).startsWith('/api/integrations/') && init?.method === 'PATCH') {
      patches++;
      if (failNext) { failNext = false; return new Response(JSON.stringify({ error: 'Fixture save failure' }), { status: 500, headers: { 'content-type': 'application/json' } }); }
      if (slowMs) await sleep(slowMs);
    }
    return nativeFetch(path, init);
  };

  try {
    await setZomato(false);

    // ---------- Shared: the API contract as this role sees it ----------
    const list = await call('GET', '/api/integrations', ownToken);
    check(list.status === 200 && /no-store/.test(list.cache ?? '') && list.json.integrations.map(i => i.id).join() === 'zomato,swiggy,kds' && list.json.integrations.every(i => i.enabled === false), 'GET /api/integrations is no-store and lists Zomato and Swiggy, both off');
    const disabledHook = await call('POST', '/api/integrations/zomato/webhook', ownToken, undefined, '{}');
    check(disabledHook.status === 503 && /turned off in the Marketplace/.test(disabledHook.json?.error ?? ''), 'Zomato webhook answers 503 "turned off in the Marketplace" while the switch is off');
    check((await call('GET', '/api/zomato/orders', ownToken)).status === 200, 'Zomato read routes stay available while the switch is off');

    if (me.role === 'admin') {
      // ---------- API validation ----------
      const bad = async body => (await call('PATCH', '/api/integrations/zomato', ownToken, body)).status;
      check(await bad({}) === 400 && await bad({ enabled: 'yes' }) === 400 && await bad({ enabled: true, extra: 1 }) === 400, 'PATCH with {}, a non-boolean or extra keys returns 400');
      check((await call('PATCH', '/api/integrations/swiggy', ownToken, { enabled: true })).status === 409 && (await call('PATCH', '/api/integrations/nope', ownToken, { enabled: true })).status === 404, 'Enabling Swiggy returns 409 and an unknown id returns 404');
      check((await call('GET', '/api/integrations', ownToken)).json.integrations[0].enabled === false, 'Rejected requests change nothing');

      // ---------- Marketplace page, Zomato off ----------
      check(!!navItem('marketplace') && !navItem('zomato'), 'Nav shows Marketplace and hides Zomato while Zomato is off');
      await goto('marketplace'); await wait(() => card('Zomato') && card('Swiggy'), 'cards');
      check(heading() === 'Marketplace' && pill('Zomato') === 'Disabled' && pill('Swiggy') === 'Coming soon', 'Marketplace shows Zomato Disabled and Swiggy Coming soon');
      const z = sw('Zomato'), s = sw('Swiggy');
      check(z.getAttribute('aria-label') === 'Zomato integration' && z.getAttribute('aria-checked') === 'false' && !z.disabled && z.tagName === 'BUTTON' && z.type === 'button' && z.tabIndex >= 0, 'Zomato switch is an enabled, focusable role=switch button');
      check(s.disabled && s.getAttribute('aria-checked') === 'false' && !settingsButton(), 'Swiggy switch is disabled and an off Zomato offers no Settings button');
      z.focus(); check(document.activeElement === z, 'Zomato switch can take keyboard focus');

      // ---------- Turn Zomato on: a slow save marks the switch aria-disabled (keeping focus), and a second click cannot send a second PATCH ----------
      patches = 0; slowMs = 400; z.click(); await sleep(80);
      check(sw('Zomato').getAttribute('aria-disabled') === 'true' && sw('Zomato').getAttribute('aria-busy') === 'true' && document.activeElement === sw('Zomato'), 'Switch is aria-disabled and keeps keyboard focus while its request is pending');
      sw('Zomato').click(); sw('Zomato').click();
      await wait(() => pill('Zomato') === 'Enabled', 'Zomato Enabled'); slowMs = 0;
      check(patches === 1 && sw('Zomato').getAttribute('aria-checked') === 'true' && !sw('Zomato').disabled && !sw('Zomato').hasAttribute('aria-disabled'), 'Clicks while pending send one PATCH; the switch ends on and re-enabled');
      check(document.activeElement === sw('Zomato'), 'Keyboard focus stays on the switch after the save');
      await wait(() => !!settingsButton(), 'Zomato Settings button');
      check(!navItem('zomato') && !!settingsButton(), 'The Settings button appears on the Zomato card (there is no Zomato nav item)');
      const stored = (await call('GET', '/api/integrations', ownToken)).json.integrations[0];
      check(stored.enabled === true && typeof stored.updatedAt === 'number', 'The new state is stored on the server');
      const enabledHook = await call('POST', '/api/integrations/zomato/webhook', ownToken, undefined, '{}');
      check(enabledHook.status === 503 && /not configured/.test(enabledHook.json?.error ?? ''), 'With Zomato on the Marketplace gate is lifted (the existing adapter check still answers)');

      // ---------- Settings opens the Zomato connection form in a dialog ----------
      settingsButton().click();
      await wait(() => document.querySelector('dialog[open] .zomato-connection'), 'Zomato settings dialog'); check(true, 'Settings opens the Zomato connection form in a dialog');
      document.querySelector('dialog[open] [aria-label="Close Zomato settings"]').click();
      await wait(() => !document.querySelector('dialog[open]'), 'Zomato settings dialog closed');

      // ---------- Dashboard Alerts show the Zomato order ----------
      await goto('home'); await wait(() => homeReady() && rows().length === 1, 'Alerts row');
      const row = rows()[0];
      check(row.textContent.includes('Zomato') && row.textContent.includes('#000201') && row.textContent.includes('Received') && row.textContent.includes('₹420.00') && row.textContent.includes('Prepaid') && /Zomato order 000201, Received, ₹420.00, Prepaid, placed/.test(row.getAttribute('aria-label')), 'Alerts lists the open Zomato order with channel, id, status, amount and payment mode');
      const billed = (await call('GET', '/api/orders', ownToken)).json.orders.filter(o => o.status === 'billed').length;
      check(document.querySelector('.dash-badge').textContent.trim() === String(rows().length + (billed > 0 ? 1 : 0)), 'Alerts badge counts the Zomato rows plus one counter alert when orders are billed');
      check(alertsText().includes('Swiggy not connected.') && [...document.querySelectorAll('.dash-alerts .dash-link')].some(b => b.textContent === 'Open Marketplace') && !alertsText().includes('Turn on Zomato'), 'Alerts says Swiggy is not connected and links admins to the Marketplace');
      row.click(); await wait(() => heading() === 'Tables & orders' && document.querySelector('.tables-zomato'), 'row opens Tables'); check(true, 'Clicking an Alerts row opens the Tables page with its Zomato panel');

      // ---------- Another counter turns Zomato off while this admin is on Reports, Zomato reconciliation: the tab goes live, no reload ----------
      await goto('Reports & Analytics'); await wait(() => zomatoTab(), 'Zomato reconciliation tab'); zomatoTab().click();
      await wait(() => document.querySelector('.zomato-screen'), 'reconciliation tab');
      await setZomato(false);
      await wait(() => !zomatoTab() && document.body.textContent.includes('Zomato reconciliation is available while Zomato is turned on in the Marketplace.'), 'tab gone');
      check(window.__marketplaceNoReload === true && !navItem('zomato') && !document.querySelector('.zomato-screen'), 'Admin on Zomato reconciliation sees the tab go with a notice, live and without a reload');
      await goto('marketplace');
      await wait(() => heading() === 'Marketplace' && card('Zomato'), 'Marketplace after notice'); check(pill('Zomato') === 'Disabled', 'The Marketplace shows Zomato disabled after it was turned off');

      // ---------- Failed save leaves the previous state and shows an alert ----------
      failNext = true; sw('Zomato').click();
      await wait(() => card('Zomato').querySelector('[role="alert"]'), 'save failure alert');
      check(card('Zomato').querySelector('[role="alert"]').textContent.includes('Fixture save failure') && sw('Zomato').getAttribute('aria-checked') === 'false' && !sw('Zomato').disabled && pill('Zomato') === 'Disabled', 'A failed save shows an alert and leaves Zomato off');

      // ---------- Turn it on from the UI, then off with a synchronous double click: one PATCH ----------
      sw('Zomato').click(); await wait(() => pill('Zomato') === 'Enabled', 'on again');
      patches = 0; slowMs = 0; sw('Zomato').click(); sw('Zomato').click();
      await wait(() => pill('Zomato') === 'Disabled' && !sw('Zomato').disabled, 'off again');
      await sleep(250);
      check(patches === 1 && sw('Zomato').getAttribute('aria-checked') === 'false' && (await call('GET', '/api/integrations', ownToken)).json.integrations[0].enabled === false, 'A rapid double-click sends exactly one PATCH');
      await goto('Reports & Analytics'); await wait(() => document.querySelector('.sales-presets') && !zomatoTab(), 'Zomato reconciliation tab hidden again');
      await goto('home'); await wait(homeReady, 'home');
      check(rows().length === 0 && alertsText().includes('Turn on Zomato or Swiggy in the Marketplace') && !!navItem('marketplace') && !navItem('zomato'), 'Turned off: Zomato nav item and Alerts rows are gone and the hint returns');
      check(((await call('GET', '/api/zomato/orders', ownToken)).json.orders ?? []).length === 1, 'Turning Zomato off leaves its orders untouched');

      // ---------- Kitchen Display: an add-on that starts off; the Kitchen tab and board follow its switch ----------
      await setKds(false);
      await goto('marketplace'); await wait(() => card('Kitchen Display (KDS)'), 'KDS card');
      const kdsCard = card('Kitchen Display (KDS)');
      check(pill('Kitchen Display (KDS)') === 'Disabled' && kdsCard.querySelector('.marketplace-tag').textContent === 'Kitchen' && !sw('Kitchen Display (KDS)').disabled && !navItem('kitchen'), 'KDS is a Kitchen add-on, off by default, with the Kitchen tab hidden');
      const refused = await call('GET', '/api/kots', ownToken);
      check(refused.status === 403 && refused.json?.code === 'kds_off', 'Kitchen API refuses tickets while KDS is off');
      sw('Kitchen Display (KDS)').click();
      await wait(() => pill('Kitchen Display (KDS)') === 'Enabled' && !!navItem('kitchen'), 'KDS on');
      check((await call('GET', '/api/kots', ownToken)).status === 200, 'Turning KDS on shows the Kitchen tab and opens the kitchen API');
      await goto('kitchen'); await wait(() => heading() === 'Kitchen display', 'kitchen board');
      check(!document.body.textContent.includes('Accept order'), 'Admin sees the kitchen board with no acceptance step');
      await setKds(false);
      await wait(() => document.body.textContent.includes('Kitchen Display is turned off') && !navItem('kitchen'), 'KDS off notice');
      check(window.__marketplaceNoReload === true && [...document.querySelectorAll('.marketplace-empty button')].some(b => b.textContent === 'Open Marketplace'), 'Turning KDS off from another counter hides the board live and offers the Marketplace');

      // ---------- A licence change refreshes the Marketplace live; View licence opens Plan & devices ----------
      // The fixture is a development build (always licensed), so the integrations list is rewritten as if the plan lacked KDS.
      let unlicensed = true;
      const countingFetch = window.fetch;
      window.fetch = async (path, init) => {
        const response = await countingFetch(path, init);
        if (!unlicensed || String(path) !== '/api/integrations' || (init?.method && init.method !== 'GET')) return response;
        const body = await response.clone().json();
        body.integrations = body.integrations.map(i => i.id === 'kds' ? { ...i, licensed: false } : i);
        return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
      };
      try {
        await goto('marketplace'); await wait(() => card('Kitchen Display (KDS)'), 'KDS card');
        window.dispatchEvent(new Event('forkflow:license-changed'));
        await wait(() => pill('Kitchen Display (KDS)') === 'Pro plan', 'KDS locked after a licence change');
        check(sw('Kitchen Display (KDS)').disabled && card('Kitchen Display (KDS)').textContent.includes('Upgrade to Pro to use the Kitchen Display'), 'A licence change refreshes the Marketplace live: KDS is locked without the plan');
        [...card('Kitchen Display (KDS)').querySelectorAll('button')].find(b => b.textContent === 'View licence').click();
        const plan = () => [...document.querySelectorAll('details')].find(d => d.querySelector('summary')?.textContent === 'Plan & devices');
        await wait(() => plan()?.open && plan().getBoundingClientRect().top < innerHeight && plan().getBoundingClientRect().bottom > 0, 'Plan & devices open and in view');
        check(true, 'View licence opens Plan & devices');
      } finally { unlicensed = false; window.fetch = countingFetch; }
      window.dispatchEvent(new Event('forkflow:license-changed'));
      await goto('marketplace'); await wait(() => pill('Kitchen Display (KDS)') === 'Disabled' && !sw('Kitchen Display (KDS)').disabled, 'KDS unlocked again');
      check(true, 'Restoring the licence unlocks the KDS switch live');
    } else if (me.role === 'cashier') {
      // ---------- Cashier: read-only Marketplace ----------
      check((await call('PATCH', '/api/integrations/zomato', ownToken, { enabled: true })).status === 403, 'A cashier PATCH is refused with 403');
      await goto('marketplace'); await wait(() => card('Zomato') && card('Swiggy'), 'cards');
      const switches = [...document.querySelectorAll('.marketplace-card [role="switch"]')];
      check(heading() === 'Marketplace' && switches.length === 3 && switches.every(s => s.disabled) && !switches.some(s => !s.disabled) && document.body.textContent.includes('Only an admin can turn integrations on or off.'), 'Cashier sees both cards with every switch disabled and an admin-only note');
      check(pill('Zomato') === 'Disabled' && pill('Swiggy') === 'Coming soon' && !navItem('zomato'), 'Cashier sees the same statuses and no Zomato nav item while it is off');
      sw('Zomato').click(); await sleep(250);
      check(patches === 0 && pill('Zomato') === 'Disabled', 'Clicking a disabled cashier switch sends no request');

      // ---------- Admin turns Zomato on from another counter: the Reports tab, Settings and Alerts appear live ----------
      await setZomato(true);
      await wait(() => pill('Zomato') === 'Enabled', 'live enable');
      check(!settingsButton() && sw('Zomato').disabled, 'Cashier sees Zomato enabled live, with no Settings button (admin only) and no working switch');
      await goto('home'); await wait(() => homeReady() && rows().length === 1, 'Alerts row');
      check(rows()[0].textContent.includes('#000201') && rows()[0].textContent.includes('Zomato') && alertsText().includes('Swiggy not connected.') && ![...document.querySelectorAll('.dash-alerts .dash-link')].some(b => b.textContent === 'Open Marketplace'), 'Cashier Alerts shows the Zomato order and no Open Marketplace link');

      // ---------- Cashier on Reports, Zomato reconciliation when an admin turns it off: the tab goes live, no reload ----------
      await goto('Reports & Analytics'); await wait(() => zomatoTab(), 'Zomato reconciliation tab'); zomatoTab().click();
      await wait(() => document.querySelector('.zomato-screen'), 'reconciliation tab');
      check(!!document.querySelector('.zomato-screen') && !document.body.textContent.includes('turned on in the Marketplace'), 'Cashier opens Zomato reconciliation from Reports while it is enabled');
      await setZomato(false);
      await wait(() => !zomatoTab() && document.body.textContent.includes('Zomato reconciliation is available while Zomato is turned on in the Marketplace.'), 'tab gone');
      check(window.__marketplaceNoReload === true && !navItem('zomato') && !document.querySelector('.zomato-screen') && ![...document.querySelectorAll('.marketplace-empty button')].some(b => b.textContent === 'Open Marketplace'), 'Cashier sees the Zomato reconciliation tab go live, without a reload, and no Open Marketplace button');
      await goto('home'); await wait(homeReady, 'home');
      check(rows().length === 0 && alertsText().includes('Ask an admin to turn on Zomato or Swiggy in the Marketplace.') && !alertsText().includes('Turn on Zomato'), 'Cashier Alerts hides Zomato rows again and asks an admin to turn it on');

      // ---------- Cashier: the Kitchen tab follows the admin KDS switch live ----------
      await setKds(false); await wait(() => !navItem('kitchen'), 'Kitchen tab hidden');
      await setKds(true); await wait(() => !!navItem('kitchen'), 'Kitchen tab shown');
      await setKds(false); await wait(() => !navItem('kitchen'), 'Kitchen tab hidden again');
      check(window.__marketplaceNoReload === true, 'Cashier Kitchen tab follows the admin KDS switch live');
    } else throw new Error('Run as admin (1234) or cashier (2345)');
    window.__marketplaceResult = { status: 'passed', role: me.role, checks };
    return window.__marketplaceResult;
  } catch (error) { window.__marketplaceResult = { status: 'failed', role: me.role, checks, error: String(error) }; throw error; }
  finally {
    window.fetch = nativeFetch;
    try { await setZomato(false); await setKds(false); } catch { /* fixture already stopped */ }
  }
})();
