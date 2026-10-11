// Evaluate on the disposable sales-dashboard fixture, signed in as admin (1234).
// Creates and settles disposable bills. Run after the dashboard/Marketplace gates, or restart the fixture afterward.
(async () => {
  if (location.origin !== 'http://127.0.0.1:4145') throw new Error('Disposable sales fixture only');
  const checks = [], reads = [];
  window.__billsHistoryProgress = checks;
  const check = (ok, name) => { if (!ok) throw new Error(name); checks.push(name); };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async (predicate, label = String(predicate)) => {
    const until = Date.now() + 10000;
    while (!predicate()) { if (Date.now() > until) throw new Error('Timed out: ' + label); await sleep(40); }
  };
  const nativeFetch = window.fetch;
  const headers = { authorization: 'Bearer ' + localStorage.getItem('forkflow.token'), 'x-forkflow-device': localStorage.getItem('forkflow.device.v1'), 'content-type': 'application/json' };
  const api = async (path, body) => {
    const response = await nativeFetch(path, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error('Fixture API ' + path + ': ' + response.status + ' ' + await response.text());
    return response.json();
  };
  const screen = () => document.querySelector('.pos-history');
  const rowElements = () => [...(screen()?.querySelectorAll('tbody tr[data-bill-id]') ?? [])];
  const visibleIds = () => rowElements().map(row => row.dataset.billId);
  const filter = () => screen()?.querySelector('select');
  const ready = () => filter() && !filter().disabled;
  const older = () => [...(screen()?.querySelectorAll('button') ?? [])].find(button => button.textContent === 'Load older bills');
  const scroller = () => screen().querySelector('.pos-table-scroll');
  const anchor = () => {
    const rootTop = scroller().getBoundingClientRect().top;
    const row = rowElements().find(item => item.getBoundingClientRect().bottom > rootTop);
    return row && { id: row.dataset.billId, offset: row.getBoundingClientRect().top - rootTop };
  };
  const checkAnchor = (saved, name) => {
    const row = rowElements().find(item => item.dataset.billId === saved.id);
    check(!!row && Math.abs(row.getBoundingClientRect().top - scroller().getBoundingClientRect().top - saved.offset) <= 2, name);
  };
  const afterPaint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const settle = bill => api(`/api/bills/${bill.id}/settle`, { clientRef: crypto.randomUUID(), payments: [{ mode: 'cash', amountPaise: bill.totalPaise }] });
  let failBefore;
  window.fetch = async (path, init) => {
    if (!String(path).startsWith('/api/bills?')) return nativeFetch(path, init);
    const parsed = new URL(String(path), location.origin);
    const response = failBefore && parsed.searchParams.get('before') === String(failBefore)
      ? new Response(JSON.stringify({ error: 'Fixture middle page unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } })
      : await nativeFetch(path, init);
    reads.push({ path: String(path), status: response.status });
    return response;
  };
  try {
    const source = [];
    for (let before; ;) {
      const page = (await api('/api/bills?status=unpaid' + (before ? '&before=' + before : ''))).bills;
      source.push(...page);
      if (page.length < 100) break;
      before = page.at(-1).billNo;
    }
    check(source.length > 200, 'Fixture contains more than 200 unpaid bills');
    const nav = document.querySelector('.nav-item[aria-label="Reports & Analytics"]');
    if (!nav) throw new Error('Reports navigation missing');
    nav.click();
    const billsTab = () => document.querySelector('[data-report="bills"]')
      ?? [...document.querySelectorAll('[aria-label="Report type"] button')].find(button => button.textContent.trim() === 'Bills');
    await wait(billsTab, 'Bills report navigation');
    billsTab().click();
    await wait(() => visibleIds().length === 100 && ready());
    check(JSON.stringify(visibleIds()) === JSON.stringify(source.slice(0, 100).map(bill => bill.id)), 'Initial history shows the newest 100 bills');
    older().click();
    await wait(() => visibleIds().length === 200 && ready());
    await sleep(400); // Let the initial WebSocket connection refresh settle before measuring subsequent events.
    await wait(ready);
    const loaded = source.slice(0, 200), boundary = loaded.at(-1).billNo;
    check(JSON.stringify(visibleIds()) === JSON.stringify(loaded.map(bill => bill.id)), 'Load older extends history to 200 ordered bills');
    const root = scroller(), target = rowElements()[130];
    root.scrollTop += target.getBoundingClientRect().top - root.getBoundingClientRect().top - 10;
    await afterPaint();
    check(root.scrollTop > 0 && root.scrollHeight > root.clientHeight, 'Bill history scrolls inside its records region');
    const saved = anchor();
    const readCount = reads.length;
    const { order: unrelated } = await api('/api/orders', { clientRef: crypto.randomUUID(), type: 'parcel' });
    await wait(() => reads.length > readCount && ready());
    await afterPaint();
    check(JSON.stringify(visibleIds()) === JSON.stringify(loaded.map(bill => bill.id)) && Number(rowElements().at(-1).cells[0].textContent.slice(1)) === boundary, 'An unrelated live order update retains all 200 rows through the loaded boundary');
    checkAnchor(saved, 'Unrelated live refresh retains the visible row and its scroll offset');

    const products = (await api('/api/products')).products;
    const product = products.find(item => item.name === 'Lunch thali');
    await api(`/api/orders/${unrelated.id}/items`, { items: [{ clientRef: crypto.randomUUID(), productId: product.id, qty: 1 }] });
    const { preview } = await api(`/api/orders/${unrelated.id}/bill-preview`, {});
    const { bill: added } = await api(`/api/orders/${unrelated.id}/bill`, { clientRef: crypto.randomUUID(), previewKey: preview.previewKey });
    await wait(() => visibleIds().length === 201 && visibleIds()[0] === added.id && ready());
    await afterPaint();
    check(Number(rowElements().at(-1).cells[0].textContent.slice(1)) === boundary, 'A new head bill appears without discarding the oldest loaded row');
    checkAnchor(saved, 'A new head bill preserves the existing visible scroll anchor');

    const removed = loaded[10];
    await settle(removed);
    const expected = [added, ...loaded.filter(bill => bill.id !== removed.id)];
    await wait(() => !visibleIds().includes(removed.id) && visibleIds().length === 200 && ready());
    await afterPaint();
    check(JSON.stringify(visibleIds()) === JSON.stringify(expected.map(bill => bill.id)), 'Settlement removes only the changed unpaid bill and preserves the loaded range');
    checkAnchor(saved, 'Settlement above the visible row preserves its scroll offset');

    const priorIds = visibleIds();
    failBefore = expected[99].billNo;
    await api('/api/orders', { clientRef: crypto.randomUUID(), type: 'parcel' });
    await wait(() => screen().querySelector('[role="alert"]').textContent.includes('Fixture middle page unavailable') && ready());
    check(JSON.stringify(visibleIds()) === JSON.stringify(priorIds), 'A failed middle refresh page retains the complete visible history');
    failBefore = undefined;
    await api('/api/orders', { clientRef: crypto.randomUUID(), type: 'parcel' });
    await wait(() => screen().querySelector('[role="alert"]').textContent === '' && ready());
    check(JSON.stringify(visibleIds()) === JSON.stringify(priorIds), 'A later live update retries successfully without shrinking history');
    check(older() && !older().disabled, 'Lookahead still offers the remaining older bills');
    older().click();
    await wait(() => visibleIds().length === source.length && !older() && ready());
    check(visibleIds().at(-1) === source.at(-1).id, 'Final Load older reaches the oldest bill and removes the exhausted paging button');
    window.__billsHistoryResult = { status: 'passed', checks, initialBills: source.length, loadedBoundary: boundary, requests: reads.length };
    return window.__billsHistoryResult;
  } catch (error) {
    window.__billsHistoryResult = { status: 'failed', checks, error: String(error), requests: reads };
    throw error;
  } finally { window.fetch = nativeFetch; }
})();
