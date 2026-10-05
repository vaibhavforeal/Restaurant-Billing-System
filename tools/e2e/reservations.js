// Run with agent-browser eval --stdin after admin setup on a disposable port-4127 server.
(async () => {
  if (location.origin !== 'http://127.0.0.1:4127') throw new Error('Use the disposable reservation QA server on port 4127.');
  const checks = [];
  const check = (ok, label) => { if (!ok) throw new Error(label); checks.push(label); };
  const wait = async (fn) => {
    const until = Date.now() + 12000;
    while (Date.now() < until) { if (fn()) return; await new Promise((resolve) => setTimeout(resolve, 30)); }
    throw new Error('Timed out: ' + document.body.innerText.slice(-1800));
  };
  const pause = () => new Promise((resolve) => setTimeout(resolve, 50));
  const button = (name, scope = document) => [...scope.querySelectorAll('button')].find((b) => b.textContent.trim() === name && (!b.closest('dialog') || b.closest('dialog').open));
  const click = async (name, scope = document) => { await wait(() => button(name, scope) && !button(name, scope).disabled); button(name, scope).click(); await pause(); };
  const field = (name) => [...document.querySelectorAll('.reservations-dialog label')].find((label) => label.textContent.startsWith(name))?.querySelector('input,select,textarea');
  const set = async (name, value) => {
    const el = field(name); if (!el) throw new Error('Missing field: ' + name);
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); await pause();
  };
  const originalFetch = window.fetch, originalConfirm = window.confirm, originalAlert = window.alert;
  const api = async (path, method = 'GET', body) => {
    const res = await originalFetch('/api' + path, { method, headers: {
      authorization: 'Bearer ' + localStorage.getItem('forkflow.token'),
      'x-forkflow-device': localStorage.getItem('forkflow.device.v1'), 'content-type': 'application/json',
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await res.json(); if (!res.ok) throw new Error(JSON.stringify(value)); return value;
  };
  const card = (name) => [...document.querySelectorAll('.reservation-card')].find((el) => el.querySelector('h3')?.textContent === name);
  const alertHas = (text) => [...document.querySelectorAll('[role="alert"]')].some((el) => el.textContent.includes(text));
  const suffix = Date.now(), guest = 'Asha ' + suffix, secondGuest = 'Meera ' + suffix;
  let release = () => {};
  try {
    window.confirm = () => true;
    document.querySelector('nav button[aria-label="home"]').click(); await pause();
    const table = (await api('/tables', 'POST', { name: 'Window ' + suffix, area: 'Patio' })).table;
    const second = (await api('/tables', 'POST', { name: 'Booth ' + suffix, area: 'Main' })).table;
    const clock = await api('/reservations');
    const tomorrow = new Date(clock.date + 'T12:00:00'); tomorrow.setDate(tomorrow.getDate() + 1);
    // Date construction stays in the restaurant's local calendar, without UTC conversion.
    const nextDate = [tomorrow.getFullYear(), String(tomorrow.getMonth() + 1).padStart(2, '0'), String(tomorrow.getDate()).padStart(2, '0')].join('-');
    document.querySelector('nav button[aria-label="tables"]').click();
    await click('Reservations'); await click('New reservation');
    await set('Guest name', guest); await set('Phone', '+91 98765 43210'); await set('Party size', '4');
    await set('Table', table.id); await set('Date and time', clock.nowLocal); await set('Notes', 'Window seat');
    let confirms = 0;
    window.confirm = () => { confirms++; return false; };
    await click('Close');
    check(confirms === 1 && !!field('Guest name'), 'Closing a changed form protects the draft');
    window.confirm = () => true;
    let requested = false, dropped = false, alerts = 0;
    const hold = new Promise((resolve) => { release = resolve; });
    window.alert = () => { alerts++; };
    window.fetch = async (...args) => {
      if (String(args[0]) === '/api/reservations' && args[1]?.method === 'POST' && !dropped) {
        requested = true; await hold; const res = await originalFetch(...args); await res.clone().json(); dropped = true;
        throw new TypeError('Simulated lost reservation acknowledgement');
      }
      return originalFetch(...args);
    };
    await click('Save reservation'); await wait(() => requested);
    check(button('Close').disabled && button('Saving\u2026').disabled, 'Saving disables duplicate submission and dialog dismissal');
    document.querySelector('nav button[aria-label="home"]').click();
    check(alerts === 1 && !!field('Guest name'), 'Navigation waits for an in-flight reservation write');
    release(); await wait(() => alertHas('Simulated lost reservation acknowledgement'));
    window.fetch = originalFetch;
    await click('Save reservation'); await wait(() => !!card(guest));
    let bookings = (await api('/reservations?date=' + clock.date)).reservations;
    let r = bookings.find((row) => row.customerName === guest);
    check(bookings.filter((row) => row.customerName === guest).length === 1, 'Retry after a lost acknowledgement saves exactly one reservation');
    check(r.partySize === 4 && r.phone === '+91 98765 43210' && r.notes === 'Window seat', 'Guest details persist in the database');
    await click('Close');
    await wait(() => [...document.querySelectorAll('.table-card.reserved')].some((el) => el.innerText.includes(table.name)));
    const tableCard = [...document.querySelectorAll('.table-card.reserved')].find((el) => el.innerText.includes(table.name));
    check(tableCard.innerText.includes(guest), 'A current reservation marks its table reserved');
    tableCard.click(); await wait(() => !!card(guest));
    check(field('Show table').value === table.id, 'Reserved table opens its filtered reservations');
    await click('New reservation'); await set('Guest name', secondGuest);
    await click('Save reservation'); await wait(() => alertHas('already has a reservation'));
    check(!!field('Guest name'), 'An overlapping booking shows an actionable error and keeps the form');
    await set('Table', second.id); await set('Date and time', nextDate + 'T19:00');
    await click('Save reservation'); await wait(() => !!card(secondGuest));
    check(field('Reservation date').value === nextDate && field('Show table').value === second.id, 'Saving another date and table follows the saved reservation');
    await click('Edit', card(secondGuest)); await set('Date and time', clock.nowLocal);
    await click('Save reservation'); await wait(() => !!card(secondGuest) && field('Reservation date').value === clock.date);
    check((await api('/reservations?date=' + nextDate)).reservations.every((row) => row.customerName !== secondGuest), 'Rescheduling removes the old date entry');
    await click('Cancel reservation', card(secondGuest));
    await wait(() => card(secondGuest)?.innerText.includes('Cancelled'));
    check((await api('/tables')).tables.find((row) => row.id === second.id).status === 'free', 'Cancellation immediately releases the table');
    await set('Show table', table.id); await wait(() => !!card(guest));
    await click('Edit', card(guest));
    await api('/reservations/' + r.id, 'PATCH', { ...r, partySize: 7 });
    await set('Notes', 'Stale draft'); await click('Save reservation'); await wait(() => alertHas('changed at another counter'));
    check((await api('/reservations?date=' + clock.date)).reservations.find((row) => row.id === r.id).partySize === 7, 'Stale edits cannot overwrite another counter');
    await click('Back to reservations'); await click('Refresh'); await wait(() => !!card(guest));
    window.fetch = async (...args) => String(args[0]).startsWith('/api/reservations?')
      ? new Response(JSON.stringify({ error: 'Reservation list unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } })
      : originalFetch(...args);
    await click('Refresh'); await wait(() => alertHas('Reservation list unavailable'));
    check(!card(guest) && button('New reservation').disabled, 'Failed refresh hides stale bookings and disables new booking');
    window.fetch = originalFetch; await click('Refresh'); await wait(() => !!card(guest));
    check(!alertHas('Reservation list unavailable'), 'Reservation list recovers after a failed refresh');
    await click('Seat & open bill', card(guest)); await wait(() => !!document.querySelector('.order-screen'));
    r = (await api('/reservations?date=' + clock.date)).reservations.find((row) => row.id === r.id);
    check(r.status === 'seated' && !!r.orderId && !document.querySelector('.reservations-dialog'), 'Seating links a saved order and opens its billing workspace');
    const order = (await api('/orders/' + r.orderId)).order;
    check(order.tableId === table.id && order.status === 'open', 'The opened order belongs to the reserved table');
    await click('\u2190 Back'); await click('Reservations');
    await wait(() => !!card(guest));
    check(!!button('Open order', card(guest)) && !button('Seat & open bill', card(guest)), 'Seated reservation reopens the existing order');
    window.__reservationChecks = { status: 'passed', checks, guest, secondGuest, date: clock.date, tableId: table.id, secondTableId: second.id, reservationId: r.id, orderId: r.orderId };
    return window.__reservationChecks;
  } finally { release(); window.fetch = originalFetch; window.confirm = originalConfirm; window.alert = originalAlert; }
})();
