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
  const button = (text) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim().replace(/ · F\d+$/, '') === text);
  const click = async (text) => { const b = await waitFor(() => button(text), `button ${text}`); if (b.disabled) throw new Error(`Disabled: ${text}`); b.click(); await new Promise((resolve) => setTimeout(resolve, 80)); };
  const field = (text) => [...document.querySelectorAll('label')].find((label) => label.textContent.trim().startsWith(text) && (text !== 'GST' || label.querySelector('select')))?.querySelector('input,select');
  const nav = async (text) => {
    const open = document.querySelector('dialog[open]');
    if (open) { [...open.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Close')?.click(); await waitFor(() => !document.querySelector('dialog[open]'), 'dialog closed'); }
    // On an order page the Tables tab is the current page, so use the order's own way back.
    if (text === 'tables' && button('tables')?.disabled) await click('← Tables'); else await click(text);
  };
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
    await nav('settings'); (await waitFor(() => document.querySelector('[data-section="profile"]'), 'profile card')).click(); await fill('GST', value); await click('Save');
    await waitFor(() => document.body.innerText.includes('Saved'), 'saved settings');
    check((await api('/settings')).settings.gstMode === value, `${value} GST mode persisted`);
  }
  async function payMode(row, label) {
    const choice = await waitFor(() => [...document.querySelectorAll(`[role=group][aria-label="Mode ${row}"] button`)].find((b) => b.textContent.trim() === label), `${label} mode ${row}`);
    choice.click(); await new Promise((resolve) => setTimeout(resolve, 80));
  }
  async function checkout() {
    await nav('tables');
    const table = await waitFor(() => [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Open table') && !b.disabled), 'a free table'); table.click(); await new Promise((resolve) => setTimeout(resolve, 80));
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
  await mode('included');
  const included = await checkout();
  check(included.totalPaise === 10500 && included.cgstPaise === 250 && included.receipt.gstMode === 'included', 'GST-included bill totals correct');
  await payMode(1, 'Cash'); await fill('Amount 1', '50'); await click('Add payment method');
  await waitFor(() => field('Amount 2'), 'second payment'); await payMode(2, 'UPI');
  check(field('Amount 2').value === '55.00', 'Remaining balance fills second payment');
  await click('Settle bill'); await waitFor(() => document.body.innerText.includes('PAID:') || document.body.innerText.includes('Paid:'), 'paid receipt');
  const paid = (await api(`/bills/${included.id}`)).bill;
  check(paid.status === 'paid' && paid.payments.length === 2 && paid.payments[0].mode === 'cash' && paid.payments[1].mode === 'upi', 'Split payment persisted once');
  await click('View receipt');
  await waitFor(() => { const html = document.querySelector('iframe')?.contentDocument?.body?.innerText || ''; return html.includes('Includes GST') && html.includes('Tax invoice'); }, 'HTML receipt');
  await waitFor(() => button('Print / save PDF') && !button('Print / save PDF').disabled, 'receipt print readiness');
  check(!button('Print / save PDF').disabled, 'Browser receipt is ready to print');
  await mode('none');
  const none = await checkout();
  check(none.totalPaise === 10500 && none.cgstPaise === 0 && none.sgstPaise === 0 && none.receipt.gstMode === 'none', 'No-GST bill adds and shows no tax');
  await payMode(1, 'Card'); await click('Settle bill');
  await waitFor(() => document.body.innerText.includes('Paid:'), 'card settlement');
  await click('View receipt');
  await waitFor(() => document.querySelector('iframe')?.contentDocument?.body?.innerText.includes('Restaurant bill'), 'no-GST receipt');
  const plain = document.querySelector('iframe').contentDocument.body.innerText;
  check(!/Tax invoice|Includes GST|CGST|SGST|Bill of supply/.test(plain), 'No-GST receipt without a GSTIN is a plain Restaurant bill with no GST lines');
  await nav('Reports & Analytics'); await click('Bills'); await fill('Show', 'paid');
  await click(`Open bill #${included.billNo}`);
  await waitFor(() => button('View receipt') || button('View bill'), 'bill actions');
  if (!button('View receipt')) await click('View bill');
  await click('View receipt');
  await waitFor(() => { const html = document.querySelector('iframe')?.contentDocument?.body?.innerText || ''; return html.includes('Includes GST') && html.includes('Tax invoice'); }, 'old receipt');
  check((await api(`/bills/${included.id}`)).bill.receipt.gstMode === 'included', 'Old GST bill keeps its mode and receipt after the switch');
  await nav('tables'); await nav('Reports & Analytics'); await click('Day-end / GST');
  await waitFor(() => document.body.innerText.includes('Total received:'), 'day-end report');
  check(document.body.innerText.includes('105.00') || document.body.innerText.includes('110.00'), 'Day-end payment breakdown rendered');
  const report = (await api('/reports/day-end')).report;
  check(report.sales.billCount >= 2 && report.payments.length === 3, 'Report matches saved cash, UPI and card collections');
  window.__m4Report = { steps, includedBill: included.billNo, noGstBill: none.billNo };
  return window.__m4Report;
})()
