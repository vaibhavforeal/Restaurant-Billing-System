// Run via agent-browser eval --stdin, signed in as admin on the disposable port-4126 server.
(async () => {
  if (location.origin !== 'http://127.0.0.1:4126') throw new Error('Use the disposable report QA server on port 4126.');
  const checks = [], downloads = [], blobs = new Map();
  const check = (ok, label) => { if (!ok) throw new Error(label); checks.push(label); };
  const wait = async (fn) => {
    const until = Date.now() + 10000;
    while (Date.now() < until) { if (fn()) return; await new Promise((resolve) => setTimeout(resolve, 30)); }
    throw new Error('Timed out: ' + document.body.innerText.slice(-1400));
  };
  const button = (name) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === name);
  const originalFetch = window.fetch, originalUrl = URL.createObjectURL, originalClick = HTMLAnchorElement.prototype.click;
  const api = async (path, method = 'GET', body) => {
    const res = await originalFetch('/api' + path, { method, headers: {
      authorization: 'Bearer ' + localStorage.getItem('forkflow.token'),
      'x-forkflow-device': localStorage.getItem('forkflow.device.v1'), 'content-type': 'application/json',
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await res.json(); if (!res.ok) throw new Error(JSON.stringify(value)); return value;
  };
  const setDate = (value) => {
    const input = document.querySelector('input[type="date"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  URL.createObjectURL = function (blob) { const url = originalUrl.call(this, blob); blobs.set(url, blob); return url; };
  HTMLAnchorElement.prototype.click = function () {
    if (this.download && blobs.has(this.href)) downloads.push({ filename: this.download, text: blobs.get(this.href).text(), bytes: blobs.get(this.href).arrayBuffer() });
    return originalClick.call(this);
  };
  let release = () => {};
  try {
    const category = (await api('/categories', 'POST', { name: 'Report QA ' + Date.now() })).category;
    const product = (await api('/products', 'POST', { categoryId: category.id, name: 'Export meal', pricePaise: 4001, gstRate: 5 })).product;
    for (const paid of [true, false]) {
      const order = (await api('/orders', 'POST', { type: 'parcel', clientRef: crypto.randomUUID() })).order;
      await api('/orders/' + order.id + '/items', 'POST', { items: [{ productId: product.id, qty: 1, clientRef: crypto.randomUUID() }] });
      const preview = (await api('/orders/' + order.id + '/bill-preview', 'POST', { discountPaise: 0 })).preview;
      const bill = (await api('/orders/' + order.id + '/bill', 'POST', { clientRef: crypto.randomUUID(), previewKey: preview.previewKey })).bill;
      if (paid) await api('/bills/' + bill.id + '/settle', 'POST', { clientRef: crypto.randomUUID(), payments: [{ mode: 'cash', amountPaise: 2000 }, { mode: 'upi', amountPaise: bill.totalPaise - 2000 }] });
    }
    document.querySelector('nav button[aria-label="Reports & Analytics"]').click();
    await wait(() => button('Export CSV') && !button('Export CSV').disabled);
    button('Refresh report').click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await wait(() => !button('Export CSV').disabled);
    const date = document.querySelector('input[type="date"]').value;
    const report = (await api('/reports/day-end?date=' + date)).report;
    button('Export CSV').click(); await wait(() => downloads.length === 1);
    const text = await downloads[0].text;
    check(downloads[0].filename === `forkflow-day-end-${date}.csv`, 'Filename uses the selected business date');
    const bytes = new Uint8Array(await downloads[0].bytes);
    check(bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191 && text.includes(report.timezone), 'CSV download includes UTF-8 BOM and server timezone');
    check(text.includes(`"Sales including GST and rounding","","${(report.sales.totalPaise / 100).toFixed(2)}","INR"`), 'Export sales agree with the saved report');
    check(text.includes(`"Still unpaid (current)","","${(report.sales.outstandingPaise / 100).toFixed(2)}","INR"`), 'Unpaid balance is included');
    check(text.includes('"GST breakdown","Taxable","5"') && text.includes('"UPI"') && text.includes('"Orders cancelled on this date"'), 'GST, collections and cancellation sections are present');
    check(text.includes(`"Round off","","${(report.sales.roundingPaise / 100).toFixed(2)}","INR"`) && report.sales.roundingPaise < 0, 'Negative rounding exports as a numeric rupee amount');

    let requested = false;
    const hold = new Promise((resolve) => { release = resolve; });
    window.fetch = async (...args) => {
      if (String(args[0]).includes('/api/reports/day-end?date=2050-01-01')) { requested = true; await hold; }
      return originalFetch(...args);
    };
    setDate('2050-01-01'); await wait(() => requested);
    check(button('Export CSV').disabled, 'Export is disabled while another date is loading');
    setDate('2000-01-01'); await wait(() => !button('Export CSV').disabled);
    release(); await new Promise((resolve) => setTimeout(resolve, 150));
    button('Export CSV').click(); await wait(() => downloads.length === 2);
    const empty = await downloads[1].text;
    check(downloads[1].filename === 'forkflow-day-end-2000-01-01.csv' && empty.includes('"Number of bills","","0","count"'), 'Empty-date export works and ignores late responses from an older request');

    window.fetch = async (...args) => String(args[0]).includes('/api/reports/day-end')
      ? new Response(JSON.stringify({ error: 'Report temporarily unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } })
      : originalFetch(...args);
    button('Refresh report').click();
    await wait(() => document.querySelector('[role="alert"]').textContent.includes('temporarily unavailable'));
    check(button('Export CSV').disabled, 'A failed refresh cannot export stale data');
    window.fetch = originalFetch;
    setDate(date); await wait(() => !button('Export CSV').disabled);
    check(document.body.innerText.includes('Total received:'), 'Report recovers after a failed request');

    document.querySelector('nav button[aria-label="catalog"]').click();
    await wait(() => button('Download template'));
    button('Download template').click(); await wait(() => downloads.length === 3);
    check((await downloads[2].text).includes('variant_price'), 'Catalog downloads still work with the shared download helper');
    document.querySelector('nav button[aria-label="Reports & Analytics"]').click();
    await wait(() => button('Export CSV') && !button('Export CSV').disabled);
    window.__reportExportChecks = { status: 'passed', checks };
    return window.__reportExportChecks;
  } finally {
    release(); window.fetch = originalFetch; URL.createObjectURL = originalUrl; HTMLAnchorElement.prototype.click = originalClick;
  }
})();
