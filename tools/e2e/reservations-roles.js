// Run after reservations.js on the same disposable server, preferably at a 390px viewport.
(async () => {
  if (location.origin !== 'http://127.0.0.1:4127' || !window.__reservationChecks) throw new Error('Run reservations.js first.');
  const checks = [], fixture = window.__reservationChecks;
  const check = (ok, name) => { if (!ok) throw new Error(name); checks.push(name); };
  const wait = async (fn) => { const until = Date.now() + 10000; while (Date.now() < until) { if (fn()) return; await new Promise((r) => setTimeout(r, 30)); } throw new Error('Timed out: ' + document.body.innerText); };
  const tick = () => new Promise((r) => setTimeout(r, 40));
  const button = (name) => [...document.querySelectorAll('button')].find((b) => (b.textContent.trim() === name || b.getAttribute('aria-label') === name) && (!b.closest('dialog') || b.closest('dialog').open));
  const click = async (name) => { await wait(() => button(name) && !button(name).disabled); button(name).click(); await tick(); };
  const set = async (el, value) => { Object.getOwnPropertyDescriptor(el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value').set.call(el, value); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); await tick(); };
  const input = (name) => [...document.querySelectorAll('.reservations-dialog label')].find((el) => el.textContent.startsWith(name))?.querySelector('input,select');
  const api = async (path, method = 'GET', body) => {
    const res = await fetch('/api' + path, { method, headers: { authorization: 'Bearer ' + localStorage.getItem('forkflow.token'), 'x-forkflow-device': localStorage.getItem('forkflow.device.v1'), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await res.json(); if (!res.ok) throw new Error(JSON.stringify(result)); return result;
  };
  const login = async (pin) => {
    if (document.querySelector('.reservations-dialog')) await click('Close Reservations');
    await click('Log out'); await wait(() => document.querySelector('[aria-label="Staff PIN"]'));
    await set(document.querySelector('[aria-label="Staff PIN"]'), pin); await click('OK');
    await wait(() => !!document.querySelector('nav')); await click('tables'); await click('Reservations');
    await wait(() => !document.querySelector('.reservations-dialog [role="status"]'));
  };
  const users = (await api('/users')).users;
  for (const [role, pin] of [['cashier', '2345'], ['waiter', '3456']]) {
    if (!users.some((u) => u.name === 'Reservation QA ' + role)) await api('/users', 'POST', { name: 'Reservation QA ' + role, role, pin });
  }
  await login('2345'); await click('New reservation');
  const now = await api('/reservations'), guest = 'No-show QA ' + Date.now();
  await set(input('Guest name'), guest); await set(input('Table'), fixture.secondTableId); await set(input('Date and time'), now.nowLocal);
  const dialog = document.querySelector('.reservations-dialog'), form = document.querySelector('.reservation-form');
  check(dialog.getBoundingClientRect().width <= innerWidth && dialog.scrollWidth <= dialog.clientWidth + 1, 'Reservation dialog fits the phone viewport');
  check(getComputedStyle(form).gridTemplateColumns.split(' ').length === 1 || innerWidth > 540, 'Reservation form stacks its fields on phones');
  check([...form.querySelectorAll('input,select,button')].every((el) => el.getBoundingClientRect().right <= innerWidth), 'Form controls remain inside the phone viewport');
  await click('Save reservation'); await wait(() => document.querySelector('.reservation-list')?.innerText.includes(guest));
  const booking = (await api('/reservations')).reservations.find((r) => r.customerName === guest);
  check(booking?.status === 'booked', 'Cashier can create a reservation through the form');
  const card = [...document.querySelectorAll('.reservation-card')].find((el) => el.innerText.includes(guest));
  const originalConfirm = window.confirm;
  try { window.confirm = () => true; [...card.querySelectorAll('button')].find((b) => b.textContent === 'No-show').click(); await wait(() => card.innerText.includes('No-show') && !card.querySelector('button')); }
  finally { window.confirm = originalConfirm; }
  check((await api('/tables')).tables.find((t) => t.id === fixture.secondTableId).status === 'free', 'Cashier marking no-show releases the table');
  await login('3456');
  await wait(() => !!document.querySelector('.reservation-card'));
  check(document.querySelector('.reservations-dialog').innerText.includes(fixture.guest), 'Waiter can view saved reservations');
  check(!button('New reservation') && !button('Edit') && !button('Seat & open bill') && !button('No-show') && !button('Cancel reservation'), 'Waiter view has no reservation management controls');
  await click('Open order'); await wait(() => !!document.querySelector('.order-screen'));
  check(!!document.querySelector('.order-screen'), 'Waiter can open an existing seated order');
  await click('\u2190 Back'); await click('Reservations');
  window.__reservationRoleChecks = { status: 'passed', checks };
  return window.__reservationRoleChecks;
})();
