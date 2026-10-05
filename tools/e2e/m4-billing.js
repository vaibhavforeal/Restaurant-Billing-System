// Run with agent-browser eval --stdin on an isolated test DB, signed in as admin.
// Uses actual DOM events for checkout; HTTP calls only create fixtures and verify persisted data.
(async () => {
  if (!/^https?:\/\/(localhost|127\.0\.0\.1):/.test(location.origin)) throw new Error('Local test server required');
  const steps = [];
  const check = (ok, message) => { if (!ok) throw new Error(message); steps.push(message); };
  const waitFor = async (fn, description) => {
    const end = Date.now() + 8000;
    while (Date.now() < end) { const value = fn(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 50)); }
    throw new Error(`Timed out: ${description}. Page: ${document.body.innerText.slice(-1800)}`);
  };
  const button = (text) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
  const click = async (text) => { const b = await waitFor(() => button(text), `button ${text}`); if (b.disabled) throw new Error(`Disabled: ${text}`); b.click(); await new Promise((resolve) => setTimeout(resolve, 80)); };
  const field = (text) => [...document.querySelectorAll('label')].find((label) => label.textContent.trim().startsWith(text))?.querySelector('input,select');
  const fill = async (text, value) => {
    const input = await waitFor(() => field(text), `field ${text}`);
    const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 60));
  };
  const api = async (path, method = 'GET', body) => {
    const r = await fetch(`/api${path}`, { method, headers: { authorization: `Bearer ${localStorage.getItem('forkflow.token')}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await r.json(); if (!r.ok) throw new Error(`${path}: ${JSON.stringify(data)}`); return data;
  };
  const suffix = Date.now();
  const { category } = await api('/categories', 'POST', { name: `Billing gate ${suffix}` });
  const productName = `Gate meal ${suffix}`;
  await api('/products', 'POST', { categoryId: category.id, name: productName, pricePaise: 10500, gstRate: 5, kotStationId: null });
  async function mode(value) {
    await click('settings'); await fill('Menu price tax mode', value); await click('Save');
    await waitFor(() => document.body.innerText.includes('Saved'), 'saved settings');
    check((await api('/settings')).settings.taxInclusive === (value === 'inclusive'), `${value} setting persisted`);
  }
  async function checkout() {
    await click('tables'); await click('New parcel');
    await waitFor(() => button('Preview bill'), 'order loaded');
    if (!button(category.name)?.disabled) await click(category.name);
    const item = await waitFor(() => [...document.querySelectorAll('button')].find((b) => b.textContent.includes(productName)), 'product');
    item.click(); await waitFor(() => button('Punch'), 'cart');
    check(button('Preview bill').disabled, 'Billing blocked while cart has unpunched items');
    await click('Punch'); await waitFor(() => !button('Punch') && !button('Preview bill').disabled, 'punched');
    await click('Preview bill'); await waitFor(() => button('Issue bill'), 'preview');
    await click('Issue bill'); await waitFor(() => button('Settle bill'), 'bill issued');
    return (await api('/bills')).bills[0];
  }
  await mode('inclusive');
  const inclusive = await checkout();
  check(inclusive.totalPaise === 10500 && inclusive.cgstPaise === 250 && inclusive.taxInclusive, 'Inclusive bill totals correct');
  await fill('Amount 1', '50'); await click('Add payment method');
  await waitFor(() => field('Amount 2'), 'second payment');
  check(field('Amount 2').value === '55.00', 'Remaining balance fills second payment');
  await click('Settle bill'); await waitFor(() => document.body.innerText.includes('PAID:') || document.body.innerText.includes('Paid:'), 'paid receipt');
  const paid = (await api(`/bills/${inclusive.id}`)).bill;
  check(paid.status === 'paid' && paid.payments.length === 2 && paid.payments[0].mode === 'cash' && paid.payments[1].mode === 'upi', 'Split payment persisted once');
  await click('View receipt');
  await waitFor(() => document.querySelector('iframe')?.contentDocument?.body?.innerText.includes('Prices include GST'), 'HTML receipt');
  await waitFor(() => button('Print / save PDF') && !button('Print / save PDF').disabled, 'receipt print readiness');
  check(!button('Print / save PDF').disabled, 'Browser receipt is ready to print');
  await mode('exclusive');
  const exclusive = await checkout();
  check(exclusive.totalPaise === 11000 && !exclusive.taxInclusive, 'Exclusive bill adds GST and rounds correctly');
  await fill('Mode 1', 'card'); await click('Settle bill');
  await waitFor(() => document.body.innerText.includes('Paid:'), 'card settlement');
  await click('bills'); await fill('Show', 'paid');
  await click(`Open bill #${inclusive.billNo}`); await click('View receipt');
  await waitFor(() => document.querySelector('iframe')?.contentDocument?.body?.innerText.includes('Prices include GST'), 'old receipt');
  check((await api(`/bills/${inclusive.id}`)).bill.taxInclusive, 'Old inclusive bill unchanged after mode switch');
  await click('Reports & Analytics');
  await waitFor(() => document.body.innerText.includes('Total received:'), 'day-end report');
  check(document.body.innerText.includes('105.00') || document.body.innerText.includes('110.00'), 'Day-end payment breakdown rendered');
  const report = (await api('/reports/day-end')).report;
  check(report.sales.billCount >= 2 && report.payments.length === 3, 'Report matches saved cash, UPI and card collections');
  window.__m4Report = { steps, inclusiveBill: inclusive.billNo, exclusiveBill: exclusive.billNo };
  return window.__m4Report;
})()
