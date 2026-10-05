// Narrow browser regression gate on the disposable preview only.
// Run after m10-takeaway.js with agent-browser eval --stdin.
(async () => {
  if (location.origin !== 'http://127.0.0.1:4121') throw new Error('Disposable http://127.0.0.1:4121 only');
  const fixtures = JSON.parse(localStorage.getItem('forkflow.qa.m10.takeaway') || 'null');
  if (fixtures?.phase !== 'complete') throw new Error('Completed takeaway gate fixtures required');
  const nativeFetch = window.fetch.bind(window);
  const result = { status: 'running', checks: [], failedOrderReads: 0 };
  const pause = () => new Promise(resolve => setTimeout(resolve, 70));
  const check = (ok, label) => { if (!ok) throw new Error(label); result.checks.push(label); };
  const wait = async (fn, label) => {
    const until = Date.now() + 18000;
    while (Date.now() < until) { const value = await fn(); if (value) return value; await pause(); }
    throw new Error('Timed out: ' + label);
  };
  const visible = value => !!value && value.getClientRects().length > 0 && getComputedStyle(value).visibility !== 'hidden' && !value.closest('[hidden],[inert]');
  const actionScope = () => document.querySelector('dialog[open]') || document;
  const button = label => [...actionScope().querySelectorAll('button')].find(b => visible(b) && (b.textContent.trim() === label || b.getAttribute('aria-label') === label));
  const click = async label => { (await wait(() => { const b = button(label); return b && !b.matches(':disabled') ? b : null; }, label)).click(); await pause(); };
  async function closeBilling() {
    if (!document.querySelector('dialog.billing-dialog[open]')) return;
    await click('Close billing');
    await wait(() => !document.querySelector('dialog.billing-dialog[open]'), 'billing dialog closed');
  }
  async function showPane(pane) {
    const toggle = actionScope().querySelector('.order-pane-switch [aria-controls="order-' + pane + '"]');
    if (visible(toggle) && toggle.getAttribute('aria-pressed') !== 'true') { toggle.click(); await pause(); }
  }
  const headers = { authorization: 'Bearer ' + localStorage.getItem('forkflow.token'), 'x-forkflow-device': localStorage.getItem('forkflow.device.v1'), 'content-type': 'application/json' };
  const api = async path => {
    const response = await nativeFetch('/api' + path, { headers });
    const body = await response.json();
    if (!response.ok) throw new Error(path + ': ' + JSON.stringify(body));
    return body;
  };
  const takeaway = () => JSON.parse(localStorage.getItem('forkflow.draft.takeaway.' + fixtures.userId) || 'null');
  try {
    await closeBilling();
    if (!(await wait(() => button('home'), 'home navigation')).disabled) await click('home');
    await click('Takeaway');
    await wait(() => document.querySelector('.order-screen select[aria-label="Menu category"]') && takeaway()?.orderId, 'empty takeaway');
    check(document.querySelector('.order-workspace .order-screen .menu-toolbar select[aria-label="Menu category"]') && document.querySelector('.order-cart .billing-footer') && document.querySelector('body > dialog.billing-dialog'), 'Current compact order layout and portaled billing dialog loaded');
    await showPane('menu');
    const category = await wait(() => {
      const select = actionScope().querySelector('select[aria-label="Menu category"]');
      return visible(select) && !select.disabled && [...select.options].some(option => option.value === fixtures.category.id) ? select : null;
    }, 'menu category');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(category, fixtures.category.id);
    category.dispatchEvent(new Event('change', { bubbles: true }));
    await pause();
    (await wait(() => [...actionScope().querySelectorAll('button.menu-card')].find(b => visible(b) && b.textContent.includes(fixtures.water.name) && !b.disabled), 'bottle menu item')).click();
    await pause();
    await showPane('cart');
    await click('Checkout');
    const method = await wait(() => [...actionScope().querySelectorAll('label')].filter(label => label.textContent.startsWith('Payment method')).map(label => label.querySelector('select')).find(visible), 'payment method');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(method, 'upi');
    method.dispatchEvent(new Event('change', { bubbles: true }));
    await pause();
    result.orderId = takeaway().orderId;
    const failedPath = '/api/orders/' + result.orderId;
    window.fetch = async (url, init) => {
      const path = new URL(url instanceof Request ? url.url : String(url), location.origin).pathname;
      const method = (init?.method || (url instanceof Request ? url.method : 'GET')).toUpperCase();
      if (path === failedPath && method === 'GET') { result.failedOrderReads++; throw new TypeError('M10 controlled order refresh failure'); }
      return nativeFetch(url, init);
    };
    await click('Issue bill & record UPI payment');
    await wait(() => document.body.innerText.includes('Payment is recorded. Reopen the order if its status has not refreshed.'), 'paid refresh guidance');
    const bill = (await api('/orders/' + result.orderId + '/bill')).bill;
    result.billId = bill.id;
    check(result.failedOrderReads > 0, 'Order refresh GET fails during payment confirmation');
    check(bill.status === 'paid' && bill.payments.length === 1 && bill.payments[0].mode === 'upi' && bill.payments[0].amountPaise === 2500, 'Exactly one full UPI payment persists despite the failed GET');
    check((await api('/orders/' + result.orderId)).order.status === 'settled', 'Order is settled despite the failed refresh');
    check((await api('/bills?status=all')).bills.filter(row => row.orderId === result.orderId).length === 1, 'One bill is issued');
    check(document.body.innerText.includes('Paid: UPI') && document.body.innerText.includes('Payment recorded.'), 'Paid confirmation remains visible with explicit refresh guidance');
    check(!Object.keys(localStorage).some(key => key.startsWith('forkflow.queue.v1.')), 'Payment queue drains after success');
    await click('View receipt');
    await wait(() => actionScope().querySelector('.billing-receipt-frame')?.contentDocument?.body?.innerText.includes('UPI'), 'paid receipt');
    check(actionScope().querySelector('.billing-receipt-frame').contentDocument.body.innerText.includes('25.00'), 'Paid receipt remains available despite order refresh failure');
    result.status = 'passed'; result.passed = result.checks.length;
  } catch (error) {
    result.status = 'failed'; result.error = String(error); result.page = document.body.innerText.slice(-2500);
  } finally {
    window.fetch = nativeFetch;
    localStorage.setItem('forkflow.qa.m10.takeaway.get-failure', JSON.stringify(result));
  }
  return result;
})()
