// Run signed into /kitchen/ on the isolated demo (4110), after demo-kitchen.js.
(async () => {
  if (location.origin !== 'http://127.0.0.1:4110' || location.pathname !== '/kitchen/') throw Error('Demo Kitchen required');
  const originalFetch = window.fetch, checks = [];
  const check = (ok, name) => { if (!ok) throw Error(name); checks.push(name); };
  const wait = async fn => { const end = Date.now() + 22000; while (Date.now() < end) { if (fn()) return; await new Promise(r => setTimeout(r, 60)); } throw Error('Kitchen wait timed out'); };
  const headers = { authorization: `Bearer ${localStorage.getItem('forkflow.kitchen.token')}`, 'x-forkflow-device': localStorage.getItem('forkflow.device.v1') };
  const tickets = () => [...document.querySelectorAll('.kitchen-ticket')];
  await wait(() => tickets().length);
  check(!document.querySelector('.sidebar') && !document.querySelector('[aria-label="Main navigation"]'), 'Dedicated kitchen has no POS navigation');
  check((await originalFetch('/api/orders', { headers })).status === 403, 'Kitchen PIN cannot read billing orders');
  check(!localStorage.getItem('forkflow.token') && !!localStorage.getItem('forkflow.kitchen.token'), 'Kitchen sign-in uses its own session storage');
  check(tickets().every(ticket => ticket.querySelectorAll('button').length === 1 && ticket.querySelector('button').textContent.includes('Done')) && !document.body.textContent.includes('Accept order'), 'Tickets offer only Done, with no acceptance step');
  const device = localStorage.getItem('forkflow.device.v1');
  const adminToken = (await (await originalFetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forkflow-device': device }, body: JSON.stringify({ pin: '1234' }) })).json()).token;
  const setKds = enabled => originalFetch('/api/integrations/kds', { method: 'PATCH', headers: { authorization: `Bearer ${adminToken}`, 'x-forkflow-device': device, 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) });
  const before = tickets().length;
  let failRead = true, failWrite = false;
  window.fetch = async (...args) => {
    const path = new URL(String(args[0]), location.href).pathname;
    if ((failRead && path === '/api/kots') || (failWrite && path.endsWith('/done'))) return new Response(JSON.stringify({ error: 'Test connection interruption' }), { status: 503 });
    return originalFetch(...args);
  };
  try {
    await wait(() => document.querySelector('[role="alert"]')?.textContent.includes('could not refresh'));
    check(tickets().length === before && tickets().every(ticket => ticket.querySelector('button').disabled), 'Failed refresh retains last tickets and disables stale actions');
    failRead = false;
    [...document.querySelectorAll('button')].find(button => button.textContent === 'Retry').click();
    await wait(() => tickets().every(ticket => !ticket.querySelector('button').disabled));
    check(!document.querySelector('[role="alert"]'), 'Retry recovers live ticket data');
    const ticketCount = tickets().length;
    check((await setKds(false)).status === 200, 'Admin turns the Kitchen Display off from another session');
    await wait(() => document.body.textContent.includes('Kitchen Display is turned off') && !tickets().length);
    check(document.body.textContent.includes('Ask an admin to turn it on in the Marketplace'), 'Board shows the turned-off notice live, without a reload');
    check((await originalFetch('/api/kots', { headers })).status === 403, 'Kitchen API refuses tickets while KDS is off');
    check((await setKds(true)).status === 200, 'Admin turns the Kitchen Display back on');
    await wait(() => tickets().length === ticketCount);
    check(!document.body.textContent.includes('Kitchen Display is turned off'), 'Open tickets return live when KDS is turned back on');
    const ticket = tickets().find(ticket => ticket.querySelector('strong').textContent === 'KOT #12');
    if (!ticket) throw Error('Run demo-kitchen.js first');
    failWrite = true; ticket.querySelector('button').click();
    await wait(() => document.querySelector('.error-message')?.textContent.includes('Test connection interruption'));
    check(ticket.isConnected, 'Failed Done request keeps the ticket available for retry');
    failWrite = false; await wait(() => !ticket.querySelector('button').disabled); ticket.querySelector('button').click();
    await wait(() => !ticket.isConnected);
    const remaining = await (await originalFetch('/api/kots', { headers })).json();
    check(!remaining.kots.some(kot => kot.kotNo === 12), 'Done persists on POS and removes the completed ticket');
    const cacheNames = await caches.keys();
    for (const name of cacheNames.filter(name => name.startsWith('forkflow-kitchen-'))) {
      const requests = await (await caches.open(name)).keys();
      check(requests.every(request => !new URL(request.url).pathname.startsWith('/api/')), 'Installed kitchen caches no restaurant API data');
    }
    return checks;
  } finally { window.fetch = originalFetch; await setKds(true); }
})()
