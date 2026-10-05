// Run after m7-recipes.js on the isolated recipes-server.mts fixture.
(async () => {
  if (location.origin !== 'http://127.0.0.1:4155') throw Error('Use recipe fixture');
  const checks = [], originalFetch = window.fetch, originalConfirm = window.confirm;
  const pause = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async fn => { const end = Date.now() + 10000; while (Date.now() < end) { if (fn()) return; await pause(40); } throw Error('Wait timed out'); };
  const check = (ok, text) => { if (!ok) throw Error(text); checks.push(text); };
  const button = text => [...document.querySelectorAll('button')].find(element => element.textContent.trim() === text || element.getAttribute('aria-label') === text);
  const click = async text => { button(text).click(); await pause(); };
  const field = text => [...document.querySelectorAll('label')].find(label => label.textContent.trim().startsWith(text))?.querySelector('input,select');
  const quantity = () => document.querySelector('[aria-label="Quantity for ingredient 1"]');
  const fill = async (element, value) => { Object.getOwnPropertyDescriptor(element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value').set.call(element, value); element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); await pause(); };
  const fixture = await (await originalFetch('/__qa/recipes')).json(), dish = fixture.products[0];
  const api = async (path, method = 'GET', payload) => { const response = await originalFetch(`/api${path}`, { method, headers: { authorization: `Bearer ${localStorage.getItem('forkflow.token')}`, 'x-forkflow-device': localStorage.getItem('forkflow.device.v1'), 'content-type': 'application/json' }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) }); const json = await response.json(); if (!response.ok) throw Error(JSON.stringify(json)); return json; };
  let failRead = false, failCreation = false, loseCreation = false, created, creationBodies = [], mockLimit = false, emptyStock = false, emptyCatalog = false;
  window.fetch = async (...args) => {
    const path = new URL(String(args[0]), location.href).pathname, method = args[1]?.method ?? 'GET';
    if (path === '/api/stock-items' && method === 'GET' && emptyStock) return new Response(JSON.stringify({ items: [] }));
    if (path === '/api/products' && method === 'GET' && emptyCatalog) return new Response(JSON.stringify({ products: [] }));
    if (path.endsWith('/stock-links') && method === 'GET') {
      if (failRead) { failRead = false; return new Response(JSON.stringify({ error: 'Reload failed' }), { status: 503 }); }
      if (mockLimit) { const body = await (await originalFetch(...args)).json(); return new Response(JSON.stringify({ ...body, links: Array.from({ length: 100 }, (_, i) => ({ ...body.links[0], id: `limit-${i}`, stockItemId: `limit-stock-${i}` })) })); }
    }
    if (path === '/api/stock-items' && method === 'POST') {
      creationBodies.push(JSON.parse(args[1].body));
      if (failCreation) { failCreation = false; return new Response(JSON.stringify({ error: 'Creation failed' }), { status: 503 }); }
      const response = await originalFetch(...args);
      if (loseCreation) { loseCreation = false; created = await response.json(); throw Error('Lost stock response'); }
      return response;
    }
    return originalFetch(...args);
  };
  window.confirm = () => true;
  try {
    await wait(() => quantity());
    const base = await api(`/products/${dish.id}/stock-links`);
    await api(`/products/${dish.id}/recipe`, 'PUT', { expectedVersion: base.version, ingredients: base.links.map(link => ({ stockItemId: link.stockItemId, qtyPerSale: link.stockItemId === fixture.stocks[0].id ? 0.26 : link.qtyPerSale })) });
    await wait(() => quantity()?.value === '260'); check(button('Save recipe').disabled, 'Clean recipe receives live changes without becoming dirty');
    await fill(quantity(), '265'); const current = await api(`/products/${dish.id}/stock-links`);
    await api(`/products/${dish.id}/recipe`, 'PUT', { expectedVersion: current.version, ingredients: current.links.map(link => ({ stockItemId: link.stockItemId, qtyPerSale: link.stockItemId === fixture.stocks[0].id ? 0.27 : link.qtyPerSale })) });
    await wait(() => button('Load latest recipe')); failRead = true; await click('Load latest recipe'); await wait(() => button('Retry loading recipe'));
    check(quantity().value === '265' && quantity().disabled && button('Save recipe').disabled && button('Add ingredient').disabled, 'Failed reload preserves but disables stale draft until retry');
    await click('Retry loading recipe'); await wait(() => quantity()?.value === '270' && !quantity().disabled); check(true, 'Reload retry recovers latest saved recipe');
    await click('Add ingredient'); await click('Create stock item'); await fill(field('Stock name'), 'Retry spice'); await fill(field('Stock unit'), 'g');
    failCreation = true; await click('Create and add ingredient'); await wait(() => document.querySelector('dialog .error-message'));
    check(field('Stock name').value === 'Retry spice' && quantity().value === '270', 'Failed stock creation preserves both forms');
    loseCreation = true; await click('Create and add ingredient'); await wait(() => document.querySelector('dialog .error-message')?.textContent.includes('Lost stock response'));
    await click('Create and add ingredient'); await wait(() => !document.querySelector('dialog[open]'));
    const all = (await api('/stock-items')).items;
    check(all.filter(item => item.id === created.item.id).length === 1 && creationBodies.every(body => body.clientRef === creationBodies[0].clientRef), 'Ambiguous creation retries reuse reference and create one stock item');
    await click('Discard changes'); await click('Jeera rice'); await wait(() => quantity());
    mockLimit = true; await click(dish.name); await wait(() => document.querySelectorAll('.recipe-ingredient').length === 100);
    check(button('Add ingredient').disabled, '100 ingredient ceiling disables adding more rows');
    mockLimit = false; await click('Jeera rice'); await wait(() => quantity()); await click(dish.name); await wait(() => quantity()?.value === '270');
    await click('Add ingredient'); check(!document.querySelector('.recipe-picker-list').textContent.includes('Archived spice'), 'Archived stock remains excluded'); await click('Close Add ingredient');
    emptyStock = true; await click('home'); await click('inventory'); await pause(); await click('Recipes'); await click('Dal tadka'); await wait(() => button('Add ingredient')); await click('Add ingredient');
    check(document.querySelector('.recipe-picker-list').textContent.includes('No unused active stock items') && button('Create stock item'), 'Empty stock list offers ingredient creation'); await click('Close Add ingredient');
    emptyStock = false; emptyCatalog = true; await click('home'); await click('inventory'); await pause(); await click('Recipes');
    check(document.querySelector('.recipe-list-empty').textContent.includes('Create a menu item in Catalog'), 'Empty catalog explains menu creation');
    emptyCatalog = false; await click('home'); await click('inventory'); await pause(); await click('Recipes'); await click(dish.name); await wait(() => quantity());
    window.__recipeEdgeChecks = checks; return checks;
  } finally { window.fetch = originalFetch; window.confirm = originalConfirm; }
})()