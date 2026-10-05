// Run with agent-browser eval --stdin on the disposable fixture, signed in as admin.
// Exercises the production UI; never run this against a restaurant database.
(async () => {
  if (location.origin !== 'http://127.0.0.1:4145') throw new Error('Disposable sales fixture only');
  const checks = [], downloads = [];
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
    await wait(() => document.querySelector('.sales-chart'));
    const initial = (await api('/api/reports/sales')).report;
    check(document.querySelector('.sales-chart desc').textContent.includes(money(initial.sales.totalPaise)) && document.querySelector('[aria-label="Collections by payment method"]').textContent.includes(money(initial.collections.totalPaise)), 'Dashboard graphs reconcile with stored report');
    check(JSON.stringify(metrics()) === JSON.stringify([money(initial.sales.totalPaise), money(initial.collections.totalPaise), String(initial.sales.billCount)]), 'Dashboard shows three metric cards reconciled with stored report');
    check(document.querySelector('.sales-metrics').getBoundingClientRect().bottom <= document.querySelector('.sales-charts').getBoundingClientRect().top, 'Dashboard metric cards appear above the graphs');
    check(!document.querySelector('.financial-home input, .financial-home .sales-report-links, .financial-home .sales-service-strip'), 'Dashboard contains metrics and graphs without date controls or bottom shortcuts');
    check(document.querySelector('.workspace').scrollHeight <= document.querySelector('.workspace').clientHeight, '1280×720 dashboard fits without scrolling');
    const chart = document.querySelector('.sales-chart'); chart.focus(); chart.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    await wait(() => document.querySelector('figcaption').textContent.includes(initial.from));
    check(document.querySelector('figcaption').textContent.includes(money(initial.daily[0].sales.totalPaise)), 'Keyboard chart selection exposes exact first-day values');
    chart.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    await wait(() => document.querySelector('figcaption').textContent.includes(initial.to));
    check(true, 'Chart End key selects final date');
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
    check(collectionCsv.filename.includes('collections-') && collectionCsv.text.includes('Cash INR') && collectionCsv.text.includes((thirty.collections.totalPaise / 100).toFixed(2)), 'Collections CSV has payment columns and matching total');
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
    window.fetch = async (path, init) => {
      if (!String(path).startsWith('/api/reports/sales')) return nativeFetch(path, init);
      const empty = structuredClone(initial);
      const zero = values => Object.keys(values).forEach(key => values[key] = 0);
      zero(empty.sales); zero(empty.collections); empty.daily.forEach(day => { zero(day.sales); zero(day.collections); });
      return new Response(JSON.stringify({ report: empty }), { headers: { 'content-type': 'application/json' } });
    };
    await click('home'); await wait(() => document.querySelector('.sales-chart'));
    check(document.querySelector('.sales-legend').textContent.includes('No activity') && !document.querySelector('.payment-bars').textContent.includes('NaN'), 'Empty charts explain no activity without NaN');
    check(document.querySelector('.workspace').scrollHeight <= document.querySelector('.workspace').clientHeight, 'Empty dashboard also fits at minimum window size');
    window.fetch = nativeFetch;
    await click('Reports & Analytics'); await wait(loaded);
    await click('home'); await wait(() => document.querySelector('.sales-chart'));
    window.__salesDashboardResult = { status: 'passed', checks, exports: downloads.map(d => ({ filename: d.filename, rows: d.text.trim().split('\r\n').length })) };
    return window.__salesDashboardResult;
  } catch (error) { window.__salesDashboardResult = { status: 'failed', checks, error: String(error) }; throw error; }
  finally { window.fetch = nativeFetch; URL.createObjectURL = nativeUrl; HTMLAnchorElement.prototype.click = nativeClick; }
})();
