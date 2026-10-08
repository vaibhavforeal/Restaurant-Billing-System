// Run with agent-browser eval --stdin on the disposable fixture, signed in as admin.
// Exercises the production UI; never run this against a restaurant database.
(async () => {
  if (location.origin !== 'http://127.0.0.1:4145') throw new Error('Disposable sales fixture only');
  const checks = [], downloads = [];
  window.__salesDashboardProgress = checks;
  const check = (ok, name) => { if (!ok) throw new Error(name); checks.push(name); };
  const wait = async (predicate) => {
    const until = Date.now() + 7000;
    while (!predicate()) { if (Date.now() > until) throw new Error('Timed out: ' + predicate); await new Promise(r => setTimeout(r, 40)); }
  };
  const button = (name) => [...document.querySelectorAll('button')].find(e => e.textContent.trim() === name);
  const click = async (name) => { const e = button(name); if (!e || e.disabled) throw new Error('Missing enabled button: ' + name); e.click(); await new Promise(r => setTimeout(r, 20)); };
  const setValue = (e, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, value); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); };
  const setPeriod = async (from, to) => { const inputs = document.querySelectorAll('.sales-period input'); setValue(inputs[0], from); setValue(inputs[1], to); await new Promise(r => setTimeout(r, 20)); await click('Apply dates'); };
  const loaded = () => document.querySelector('.sales-metrics') && button('Refresh') && !button('Refresh').disabled;
  const dashboardLoaded = () => document.querySelector('.dash-channel-total .dash-channel-amount')?.textContent !== '—' && document.querySelector('.dash-stat-successful strong')?.textContent !== '—' && document.querySelector('.dash-slot-chart') && !document.querySelector('[aria-label="Refreshing dashboard"]');
  const money = n => '₹' + (n / 100).toFixed(2);
  const metrics = () => [...document.querySelectorAll('.sales-metric > strong')].map(e => e.textContent);
  const nativeFetch = window.fetch, nativeUrl = URL.createObjectURL, nativeClick = HTMLAnchorElement.prototype.click;
  const api = async path => {
    const r = await nativeFetch(path, { headers: { authorization: 'Bearer ' + localStorage.getItem('forkflow.token'), 'x-forkflow-device': localStorage.getItem('forkflow.device.v1') } });
    if (!r.ok) throw new Error('Fixture API: ' + r.status); return r.json();
  };
  let nextBlob;
  URL.createObjectURL = function(blob) { nextBlob = blob; return nativeUrl.call(this, blob); };
  HTMLAnchorElement.prototype.click = function() {
    if (this.download) { const entry = { filename: this.download, text: '' }; downloads.push(entry); void nextBlob.text().then(text => entry.text = text); }
    return nativeClick.call(this);
  };
  const captureExport = async name => { const n = downloads.length; const summary = [...document.querySelectorAll('summary')].find(e => e.textContent.includes('Export')); summary.click(); await click(name); await wait(() => downloads.length > n && downloads[n].text); return downloads[n]; };
  try {
    await wait(dashboardLoaded);
    const initial = (await api('/api/reports/sales')).report;
    const day = initial.today;
    const [dineIn, takeaway] = await Promise.all(['dine_in', 'parcel'].map(async type => (await api(`/api/reports/analytics?from=${day}&to=${day}&type=${type}`)).report));
    const dayEnd = (await api(`/api/reports/day-end?date=${day}`)).report;
    const todaySales = (await api(`/api/reports/sales?from=${day}&to=${day}`)).report;
    const openOrders = (await api('/api/orders')).orders;
    const card = key => { const e = document.querySelector(`.dash-channel-${key}`); return [e.querySelector('.dash-channel-amount').textContent, e.querySelector('small').textContent]; };
    const orders = n => `${n} ${n === 1 ? 'Order' : 'Orders'}`;
    const strip = document.querySelector('.dash-strip');

    // Status strip
    const dateInput = strip.querySelector('input[type="date"]');
    check(dateInput.value === day && dateInput.max === day && /^Updated/.test(strip.querySelector('.dash-strip-status').textContent), 'Status strip date defaults to today, cannot pass today, and shows an Updated label');
    check(!document.querySelector('.sales-metrics, .sales-chart, .sales-metrics-overview'), 'Old three-card overview and trend chart are gone from Home');

    // Channel cards reconcile with /api/reports/analytics (each channel from its own report's totals)
    check(JSON.stringify(card('dine-in')) === JSON.stringify([money(dineIn.totals.totalPaise), orders(dineIn.totals.orderCount)])
      && JSON.stringify(card('takeaway')) === JSON.stringify([money(takeaway.totals.totalPaise), orders(takeaway.totals.orderCount)])
      && JSON.stringify(card('total')) === JSON.stringify([money(dineIn.totals.totalPaise + takeaway.totals.totalPaise), orders(dineIn.totals.orderCount + takeaway.totals.orderCount)]),
      'Total Sales, Dine In and Takeaway cards reconcile with the analytics report');
    check(dineIn.totals.totalPaise > 0 && takeaway.totals.totalPaise > 0, 'Fixture has activity in both channels today');

    // Slot chart: description lists the same totals; the 00:00-00:59 hour belongs to the LAST slot (21:00-01:00)
    const labels = ['01:00am - 05:00am', '05:00am - 09:00am', '09:00am - 01:00pm', '01:00pm - 05:00pm', '05:00pm - 09:00pm', '09:00pm - 01:00am'];
    const slotOf = hour => Math.floor(((hour + 23) % 24) / 4);
    const sums = hourly => { const out = [0, 0, 0, 0, 0, 0]; for (const row of hourly) out[slotOf(row.hour)] += row.totalPaise; return out; };
    const dineSlots = sums(dineIn.hourly), takeSlots = sums(takeaway.hourly);
    const expectedDesc = labels.map((label, i) => `${label}: dine in ${money(dineSlots[i])}, takeaway ${money(takeSlots[i])}`).join('; ') + '.';
    const desc = document.querySelector('.dash-slot-chart desc').textContent;
    check(desc === expectedDesc, 'Slot chart description lists the same totals as the analytics hours');
    const midnight = dineIn.hourly.find(h => h.hour === 0)?.totalPaise ?? 0;
    check(midnight > 0 && dineSlots[5] >= midnight && dineSlots[0] === 0 && desc.includes(`${labels[5]}: dine in ${money(dineSlots[5])}`) && desc.includes(`${labels[0]}: dine in ${money(0)}, takeaway ${money(0)}`),
      'A 00:30 bill is counted in the 9pm-1am slot, not in 1am-5am');
    check(document.querySelector('.dash-slots').getBoundingClientRect().width > 300 && document.querySelectorAll('.dash-slot-chart .dash-bar').length >= 4 && !document.querySelector('.dash').textContent.includes('NaN'), 'Slot chart renders bars and no NaN');

    // Payment breakdown reconciles with /api/reports/sales
    const payments = document.querySelector('[aria-label="Collections by payment method"]').textContent;
    check(payments.includes(money(todaySales.collections.totalPaise)) && payments.includes(money(todaySales.collections.cashPaise)) && payments.includes(money(todaySales.collections.upiPaise)) && payments.includes(money(todaySales.collections.cardPaise)), 'Payment breakdown reconciles with the sales report');

    // Order statistics
    const stat = key => document.querySelector(`.dash-stat-${key} strong`).textContent;
    const open = openOrders.filter(o => o.status === 'open').length, billed = openOrders.filter(o => o.status === 'billed').length;
    check(stat('successful') === String(dayEnd.sales.billCount) && stat('cancelled') === String(dayEnd.cancellations.orderCount) && stat('in-progress') === String(open) && open >= 1 && dayEnd.cancellations.orderCount >= 1,
      'Order statistics reconcile with day-end and open orders');

    // Alerts with Zomato switched off in the Marketplace
    const alerts = document.querySelector('.dash-alerts');
    check(alerts.textContent.includes('Turn on Zomato or Swiggy in the Marketplace') && !alerts.querySelector('.dash-alert-row')
      && !performance.getEntriesByType('resource').some(e => e.name.includes('/api/zomato/orders')), 'Alerts explain how to enable Zomato and request no Zomato orders while it is off');
    check(billed >= 1 && alerts.querySelector('.dash-operational').textContent.includes(`${billed} billed ${billed === 1 ? 'order' : 'orders'} awaiting payment`) && alerts.querySelector('.dash-badge').textContent.trim() === String(alerts.querySelectorAll('.dash-alert-row').length + (billed > 0 ? 1 : 0)),
      'Billed-but-unpaid orders appear as an operational alert and the badge counts them');
    const navLabels = [...document.querySelectorAll('.nav-item')].map(e => e.getAttribute('aria-label'));
    check(navLabels.includes('marketplace') && !navLabels.includes('zomato'), 'Nav shows Marketplace and hides Zomato while Zomato is off');

    // Layout at 1280x720: no horizontal overflow; the page itself never scrolls; the key panels sit above the fold.
    // The workspace scrolls internally to reach Payment collections; the overflow is recorded rather than hidden.
    const workspace = document.querySelector('.workspace');
    check(document.documentElement.scrollWidth <= innerWidth && workspace.scrollWidth <= workspace.clientWidth && document.documentElement.scrollHeight <= innerHeight, 'No horizontal overflow and the page itself does not scroll');
    check(['.dash-channels', '.dash-slots', '.dash-alerts', '.dash-stats'].every(sel => document.querySelector(sel).getBoundingClientRect().bottom <= innerHeight), 'Channel cards, slot chart, Alerts and Order Statistics are fully visible at 1280x720');
    const workspaceOverflowPx = workspace.scrollHeight - workspace.clientHeight;

    // Keyboard on the slot chart
    const chart = document.querySelector('.dash-slot-chart'); chart.focus();
    chart.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    await wait(() => document.querySelector('.dash-slot-detail').textContent.includes(labels[0]));
    check(document.querySelector('.dash-slot-detail').textContent.includes(money(dineSlots[0])), 'Keyboard Home selects the first slot with exact values');
    chart.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    await wait(() => document.querySelector('.dash-slot-detail').textContent.includes(labels[5]));
    check(document.querySelector('.dash-slot-detail').textContent.includes(money(dineSlots[5])) && document.querySelector('.dash-slot-detail').textContent.includes(money(takeSlots[5])), 'Keyboard End selects the 9pm-1am slot with exact dine-in and takeaway values');
    chart.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await wait(() => document.querySelector('.dash-slot-detail').textContent.includes(labels[4]));
    check(true, 'Keyboard ArrowLeft moves to the previous slot');

    // Another date: an empty day shows zeros and no NaN; a future date is refused
    setValue(dateInput, '2020-01-01');
    await wait(() => card('total')[1] === '0 Orders');
    check(card('total')[0] === '₹0.00' && card('dine-in')[0] === '₹0.00' && card('takeaway')[1] === '0 Orders'
      && document.querySelector('.dash-slot-chart desc').textContent === labels.map(label => `${label}: dine in ${money(0)}, takeaway ${money(0)}`).join('; ') + '.'
      && !document.querySelector('.dash').textContent.includes('NaN') && document.querySelector('.dash-slots').textContent.includes('No sales on this day') && stat('successful') === '0', 'An empty date shows zero cards, a zero-axis chart and no NaN');
    // The field keeps the typed draft (so partial years are not wiped mid-keystroke); the dashboard must not move, and blur restores the field
    const futureRequests = [];
    window.fetch = (path, init) => { if (String(path).includes('2999-01-01')) futureRequests.push(String(path)); return nativeFetch(path, init); };
    dateInput.focus(); setValue(dateInput, '2999-01-01'); await new Promise(r => setTimeout(r, 120));
    window.fetch = nativeFetch;
    const stayedOnEmptyDay = card('total')[1] === '0 Orders' && document.querySelector('.dash-slots').textContent.includes('No sales on this day');
    dateInput.blur(); await new Promise(r => setTimeout(r, 40));
    check(futureRequests.length === 0 && stayedOnEmptyDay && dateInput.value === '2020-01-01', 'A future date is not accepted');
    setValue(dateInput, day);
    await wait(() => card('total')[1] === orders(dineIn.totals.orderCount + takeaway.totals.orderCount) && dashboardLoaded());
    check(card('dine-in')[0] === money(dineIn.totals.totalPaise), 'Returning to today restores the figures');

    // A failed analytics request keeps the figures, says so, and Retry recovers
    window.fetch = async (path, init) => String(path).startsWith('/api/reports/analytics') ? new Response(JSON.stringify({ error: 'Fixture analytics outage' }), { status: 503, headers: { 'content-type': 'application/json' } }) : nativeFetch(path, init);
    document.querySelector('[aria-label="Refresh dashboard"]').click();
    await wait(() => document.querySelector('.dash-error')?.textContent.includes('Fixture analytics outage'));
    check(card('dine-in')[0] === money(dineIn.totals.totalPaise) && document.querySelector('.dash-error').textContent.includes('may be incomplete'), 'Failed refresh keeps the last figures and shows an alert with Retry');
    window.fetch = nativeFetch; button('Retry').click();
    await wait(() => !document.querySelector('.dash-error') && dashboardLoaded());
    check(card('dine-in')[0] === money(dineIn.totals.totalPaise), 'Retry recovers after the outage');

    await click('Reports & Analytics'); await wait(loaded);
    check(JSON.stringify(metrics()) === JSON.stringify([money(initial.sales.totalPaise), money(initial.collections.totalPaise), String(initial.sales.billCount), money(initial.sales.outstandingPaise)]), 'Detailed metrics and date controls remain in Reports');
    await click('Today'); await wait(loaded);
    const today = (await api(`/api/reports/sales?from=${initial.today}&to=${initial.today}`)).report;
    check(metrics()[0] === money(today.sales.totalPaise) && document.querySelector('.sales-range-caption').textContent.includes(initial.today), 'Today preset reconciles');
    await click('30 days'); await wait(loaded);
    const thirtyFrom = document.querySelector('.sales-period input').value;
    const thirty = (await api(`/api/reports/sales?from=${thirtyFrom}&to=${initial.today}`)).report;
    check(thirty.daily.length === 30 && metrics()[1] === money(thirty.collections.totalPaise), '30-day preset reconciles');
    check(document.querySelectorAll('.sales-report-table tbody tr').length === 30, 'Report contains all selected dates');
    const salesCsv = await captureExport('Export sales CSV');
    check(salesCsv.filename === `forkflow-sales-${thirtyFrom}-to-${initial.today}.csv` && salesCsv.text.includes('"TOTAL"') && salesCsv.text.includes((thirty.sales.totalPaise / 100).toFixed(2)), 'Sales CSV uses displayed dates and exact totals');
    check(document.querySelector('.workspace').scrollHeight <= document.querySelector('.workspace').clientHeight, 'Long report scrolls inside table at 1280×720');
    const table = document.querySelector('.sales-report-table'); table.scrollTop = table.scrollHeight;
    check(getComputedStyle(table.querySelector('thead th')).position === 'sticky' && getComputedStyle(table.querySelector('tfoot td')).position === 'sticky', 'Report header and totals remain sticky');
    await click('Collections');
    check(document.querySelector('.sales-report-table tfoot').textContent.includes(money(thirty.collections.totalPaise)), 'Collections table reconciles with API');
    const collectionCsv = await captureExport('Export collections CSV');
    check(collectionCsv.filename.includes('collections-') && collectionCsv.text.includes('Cash (net) INR') && collectionCsv.text.includes((thirty.collections.totalPaise / 100).toFixed(2)), 'Collections CSV has payment columns and matching total');
    await click('Sales'); table.scrollTop = 0; await click(thirtyFrom);
    await wait(() => document.querySelector('.pos-report-grid'));
    check(document.querySelector('.legacy-screen input').value === thirtyFrom, 'Daily row opens unchanged Day-end/GST for selected date');
    const dayCsv = await captureExport('Export CSV');
    check(dayCsv.filename === `forkflow-day-end-${thirtyFrom}.csv`, 'Existing day-end CSV remains available');
    await click('Sales'); await setPeriod('2020-01-01', '2020-01-03'); await wait(loaded);
    check(metrics().every(v => v === '₹0.00' || v === '0') && document.querySelectorAll('.sales-report-table tbody tr').length === 3, 'Empty periods show zero totals and complete daily rows');
    await click('Day-end / GST'); await wait(() => document.querySelector('.pos-report-grid'));
    check(document.querySelector('.legacy-screen input').value === '2020-01-03', 'Day-end tab starts at current report end date');
    await click('Sales'); await setPeriod('2020-01-04', '2020-01-03');
    check(document.querySelector('[role="alert"]').textContent.includes('start date'), 'Reversed range is rejected with visible feedback');
    await setPeriod('2020-01-01', '2022-01-01'); await wait(() => document.querySelector('[role="alert"]')?.textContent.includes('366'));
    check(!document.querySelector('.sales-metrics') && !document.querySelector('.sales-report-table'), 'Invalid server range clears stale results');
    const summary = [...document.querySelectorAll('summary')].find(e => e.textContent.includes('Export')); if (!summary.parentElement.open) summary.click();
    check(button('Export sales CSV').disabled, 'Stale report cannot be exported');
    await click('7 days'); await wait(loaded);
    window.fetch = async (path, init) => String(path).startsWith('/api/reports/sales') ? new Response(JSON.stringify({ error: 'Fixture reporting outage' }), { status: 503, headers: { 'content-type': 'application/json' } }) : nativeFetch(path, init);
    await click('Refresh'); await wait(() => document.querySelector('[role="alert"]')?.textContent.includes('Fixture reporting outage'));
    check(!document.querySelector('.sales-report-table') && !document.querySelector('.sales-reports [role="status"]'), 'Failed refresh clears stale data and download success message');
    window.fetch = nativeFetch; await click('Refresh'); await wait(loaded);
    check(metrics()[0] === money(initial.sales.totalPaise), 'Refresh recovers after outage');
    let delayed = false;
    window.fetch = async (path, init) => {
      if (String(path).startsWith('/api/reports/sales') && !delayed) { delayed = true; const response = await nativeFetch(path, { ...init, signal: undefined }); await new Promise(r => setTimeout(r, 500)); return response; }
      return nativeFetch(path, init);
    };
    await click('Today'); await click('30 days'); await wait(loaded); await new Promise(r => setTimeout(r, 650));
    check(document.querySelectorAll('.sales-report-table tbody tr').length === 30 && metrics()[0] === money(thirty.sales.totalPaise), 'Late prior-range response cannot replace current report');
    await click('home'); await wait(dashboardLoaded);
    check(card('total')[0] === money(dineIn.totals.totalPaise + takeaway.totals.totalPaise), 'Home returns to today after visiting Reports');
    window.__salesDashboardResult = { status: 'passed', checks, workspaceOverflowPx, exports: downloads.map(d => ({ filename: d.filename, rows: d.text.trim().split('\r\n').length })) };
    return window.__salesDashboardResult;
  } catch (error) { window.__salesDashboardResult = { status: 'failed', checks, error: String(error) }; throw error; }
  finally { window.fetch = nativeFetch; URL.createObjectURL = nativeUrl; HTMLAnchorElement.prototype.click = nativeClick; }
})();
