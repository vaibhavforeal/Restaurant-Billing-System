// Run with agent-browser eval --stdin after admin setup on a disposable port-4125 server.
(async () => {
  if (location.origin !== 'http://127.0.0.1:4125') throw new Error('Use the disposable catalog QA server on port 4125.');
  const checks = [], downloads = [];
  const check = (ok, label) => { if (!ok) throw new Error(label); checks.push(label); };
  const wait = async (fn) => {
    const until = Date.now() + 15000;
    while (Date.now() < until) { if (fn()) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
    throw new Error('Timed out: ' + document.body.innerText.slice(-1800));
  };
  const button = (name) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === name);
  const click = async (name) => { await wait(() => button(name) && !button(name).disabled); button(name).click(); };
  const api = async (path, method = 'GET', body) => {
    const response = await fetch('/api' + path, { method, headers: {
      authorization: 'Bearer ' + localStorage.getItem('forkflow.token'),
      'x-forkflow-device': localStorage.getItem('forkflow.device.v1'), 'content-type': 'application/json',
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); return result;
  };
  const choose = (csv) => {
    const input = document.querySelector('[aria-label="Choose item CSV"]');
    const transfer = new DataTransfer(); transfer.items.add(new File([csv], 'qa-items.csv', { type: 'text/csv' }));
    input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const originalUrl = URL.createObjectURL;
  URL.createObjectURL = function (blob) { downloads.push(blob.text()); return originalUrl.call(this, blob); };
  try {
    document.querySelector('nav button[aria-label="catalog"]').click();
    await wait(() => button('Export CSV'));
    check(!!button('Import CSV') && !!button('Download template'), 'Catalog transfer controls render');
    const before = (await api('/products')).products.length;
    await click('Download template'); await wait(() => downloads.length === 1);
    const name = 'CSV tea ' + Date.now();
    const template = (await downloads[0]).replaceAll('Masala chai', name);
    check(template.includes('variant_price') && template.includes('Large'), 'Template download contains an item and variant');
    choose(template); await wait(() => button('Import 1 items') && !button('Import 1 items').disabled);
    check((await api('/products')).products.length === before, 'File selection previews without database writes');
    check(document.querySelector('.catalog-import-preview').innerText.includes('1 variants to add'), 'Preview reports item and variant counts');
    await click('Import 1 items'); await wait(() => document.body.innerText.includes('Import complete: 1 items added'));
    let item = (await api('/products')).products.find((p) => p.name === name);
    check(item.pricePaise === 4000 && item.variants[0].pricePaise === 6000, 'Import saves exact item and variant prices');
    await wait(() => !button('Export CSV').disabled);
    await click('Export CSV'); await wait(() => downloads.length === 2);
    const exported = await downloads[1];
    check(exported.includes(item.id) && exported.includes(item.variants[0].id), 'Export download contains persistent item and variant IDs');
    await wait(() => !button('Import CSV').disabled);
    choose('category,name,price,gst_rate\nNew,Valid,10,5\nNew,Bad,wrong,5');
    await wait(() => document.querySelector('[role="alert"]').textContent.includes('Row 3: price'));
    check((await api('/products')).products.length === before + 1, 'Invalid CSV shows row error and saves nothing');
    await wait(() => !button('Import CSV').disabled);
    choose(exported.replaceAll('"40.00"', '"45.25"'));
    await wait(() => button('Import ' + (before + 1) + ' items') && !button('Import ' + (before + 1) + ' items').disabled);
    await api('/products/' + item.id, 'PATCH', { description: 'Changed by another counter' });
    await click('Import ' + (before + 1) + ' items');
    await wait(() => document.querySelector('[role="alert"]').textContent.includes('catalog changed after preview'));
    check((await api('/products')).products.find((p) => p.id === item.id).pricePaise === 4000, 'Stale preview prevents overwriting concurrent changes');
    await click('Preview again'); await wait(() => button('Import ' + (before + 1) + ' items') && !button('Import ' + (before + 1) + ' items').disabled);
    await click('Import ' + (before + 1) + ' items'); await wait(() => document.body.innerText.includes('Import complete: 0 items added'));
    item = (await api('/products')).products.find((p) => p.id === item.id);
    check(item.pricePaise === 4525 && (await api('/products')).products.length === before + 1, 'Re-preview and import update by ID without duplicates');
    check(!document.querySelector('vite-error-overlay'), 'No application error overlay');
    window.__catalogTransferReport = { status: 'passed', checks };
    return window.__catalogTransferReport;
  } finally { URL.createObjectURL = originalUrl; }
})();
