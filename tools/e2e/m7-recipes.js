// Run with UTF-8 stdin via agent-browser against tools/e2e/recipes-server.mts.
(async () => {
  if (location.origin !== 'http://127.0.0.1:4155') throw new Error('Use the isolated recipes fixture on port 4155');
  const checks = [], writes = [];
  const originalFetch = window.fetch, originalConfirm = window.confirm, originalAlert = window.alert;
  const delay = (ms = 80) => new Promise(resolve => setTimeout(resolve, ms));
  const check = (ok, message) => { if (!ok) throw new Error(message); checks.push(message); };
  const wait = async (fn, message) => { const end = Date.now() + 10000; while (Date.now() < end) { if (fn()) return; await delay(40); } throw new Error(`Timed out: ${message}`); };
  const button = text => [...document.querySelectorAll('button')].find(element => element.textContent.trim() === text || element.getAttribute('aria-label') === text);
  const click = async text => { await wait(() => button(text) && !button(text).disabled, text); button(text).click(); await delay(); };
  const field = text => [...document.querySelectorAll('label')].find(label => label.textContent.trim().startsWith(text))?.querySelector('input,select');
  const quantity = index => document.querySelector(`[aria-label="Quantity for ingredient ${index}"]`);
  const unit = index => document.querySelector(`[aria-label="Unit for ingredient ${index}"]`);
  const rows = () => [...document.querySelectorAll('.recipe-ingredient')];
  const fill = async (element, value) => {
    if (!element || element.disabled) throw new Error('Missing/enabled field');
    Object.getOwnPropertyDescriptor(element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value').set.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); await delay();
  };
  const api = async (path, method = 'GET', payload) => {
    const response = await originalFetch.call(window, `/api${path}`, { method, headers: { authorization: `Bearer ${localStorage.getItem('forkflow.token')}`, 'x-forkflow-device': localStorage.getItem('forkflow.device.v1'), 'content-type': 'application/json' }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    const body = await response.json(); if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(body)}`); return body;
  };
  const fixture = await (await originalFetch('/__qa/recipes')).json();
  const [dish, other] = fixture.products, [rice, oil, salt] = fixture.stocks;
  const { printer } = await api('/printers', 'POST', { name: 'Recipe test printer', kind: 'network', connection: '127.0.0.1:9999', paperWidth: 80 });
  const { station } = await api('/kot-stations', 'POST', { name: 'Recipe test kitchen', printerId: printer.id });
  await api(`/products/${dish.id}`, 'PATCH', { kotStationId: station.id });
  const initial = await api('/products/' + dish.id + '/stock-links');
  await api('/products/' + dish.id + '/recipe', 'PUT', { expectedVersion: initial.version, ingredients: [{ stockItemId: rice.id, qtyPerSale: 0.25 }, { stockItemId: oil.id, qtyPerSale: 0.015 }, { stockItemId: salt.id, qtyPerSale: 2 }] });
  const otherInitial = await api('/products/' + other.id + '/stock-links');
  await api('/products/' + other.id + '/recipe', 'PUT', { expectedVersion: otherInitial.version, ingredients: [] });
  const saved = () => api(`/products/${dish.id}/stock-links`);
  const choose = async name => { await click(name); await wait(() => document.querySelector('.recipe-editor')?.getAttribute('aria-busy') === 'false', 'recipe loaded'); };
  const remove = async index => { document.querySelector(`[aria-label="Remove ingredient ${index}"]`).click(); await delay(); };
  const add = async (name, amount) => { await click('Add ingredient'); await wait(() => document.querySelector('dialog[open]'), 'picker'); const choice = [...document.querySelectorAll('.recipe-picker-list button')].find(element => element.querySelector('span')?.firstChild?.textContent === name); if (!choice) throw new Error(`No ingredient ${name}`); choice.click(); await delay(); await fill(quantity(rows().length), String(amount)); };
  const save = async () => { await click('Save recipe'); await wait(() => button('Save recipe')?.disabled && document.querySelector('.recipe-success'), 'saved'); return saved(); };
  let failLoad = false, failSave = false, holdSave = false, releaseSave, holdStock = false, releaseStock;
  window.fetch = async (...args) => {
    const path = new URL(String(args[0]), location.href).pathname, method = args[1]?.method ?? 'GET';
    if (failLoad && path.endsWith('/stock-links') && method === 'GET') { failLoad = false; return new Response(JSON.stringify({ error: 'Simulated load failure' }), { status: 503 }); }
    if (holdStock && path === '/api/stock-items' && method === 'POST') { holdStock = false; await new Promise(resolve => releaseStock = resolve); }
    if (method === 'PUT' && (path.endsWith('/recipe') || path.endsWith('/stock-links'))) {
      if (holdSave) { holdSave = false; await new Promise(resolve => releaseSave = resolve); }
      if (failSave) { failSave = false; return new Response(JSON.stringify({ error: 'Simulated save failure' }), { status: 503 }); }
      const response = await originalFetch.apply(window, args); writes.push({ path, status: response.status, body: JSON.parse(args[1].body) }); return response;
    }
    return originalFetch.apply(window, args);
  };
  window.confirm = () => true; window.alert = () => {};
  try {
    if (button('inventory')?.disabled) await click('home');
    await click('inventory');
    check(document.querySelector('[role="tab"][aria-selected="true"]').textContent === 'Stock', 'Stock is the default Inventory tab');
    await click('Recipes'); await choose(dish.name);
    check(quantity(1).value === '250' && unit(1).value === 'g' && quantity(2).value === '15' && unit(2).value === 'ml', 'Saved kg/L recipes load in g/ml');
    await fill(unit(1), 'kg'); check(quantity(1).value === '0.25' && button('Save recipe')?.disabled, 'Unit switching preserves amount and clean state');
    await fill(unit(1), 'g');
    await fill(quantity(1), '1.5'); await click('Save recipe');
    check(document.querySelector('.recipe-field-error')?.textContent.includes('whole g') && document.activeElement === quantity(1), 'Unsupported precision shows inline validation and focuses amount');
    await fill(quantity(1), '275');
    let prompts = 0; window.confirm = () => { prompts++; return false; };
    await click(other.name); await click('Stock'); await click('tables'); await click('Log out');
    check(quantity(1).value === '275' && prompts === 4, 'Product, tab, navigation and logout guards preserve declined drafts');
    await click('Add ingredient');
    check(!document.querySelector('.recipe-picker-list').textContent.includes('Rice') && !document.querySelector('.recipe-picker-list').textContent.includes('Archived spice'), 'Picker excludes selected and archived ingredients');
    await click('Close Add ingredient');
    check(document.activeElement === button('Add ingredient'), 'Closing picker restores focus');
    await click('Add ingredient'); await fill(field('Find ingredient'), 'Cumin workflow'); await click('Create stock item');
    check(field('Stock name').value === 'Cumin workflow' && field('Opening quantity').value === '0', 'Missing ingredient creation starts with search name and zero opening stock');
    await fill(field('Stock unit'), 'g');
    holdStock = true; await click('Create and add ingredient');
    check(document.querySelector('#inventory-stock-tab').disabled && button('Close Create stock item').disabled, 'Stock creation blocks leaving while request is pending');
    releaseStock(); await wait(() => rows().length === 4 && !document.querySelector('dialog[open]'), 'created ingredient added');
    check(quantity(1).value === '275' && quantity(4).value === '' && document.activeElement === quantity(4), 'Stock creation preserves recipe draft and focuses the new blank amount');
    const { items } = await api('/stock-items'); const cumin = items.find(item => item.name === 'Cumin workflow');
    check(cumin && cumin.qty === 0 && !(await saved()).links.some(link => link.stockItemId === cumin.id), 'Created stock exists immediately while recipe remains unsaved');
    await fill(quantity(4), '1.25');
    failSave = true; await click('Save recipe');
    check(document.querySelector('.recipe-error').textContent.includes('Simulated save failure') && quantity(1).value === '275', 'Failed save preserves draft and permits retry');
    window.confirm = () => true;
    holdSave = true; await click('Save recipe');
    check(document.querySelector('#inventory-stock-tab').disabled && button(other.name).disabled && quantity(1).disabled, 'Pending recipe save locks product, tab and quantity editing');
    document.querySelector('.recipe-actions button.primary').click(); releaseSave();
    await wait(() => button('Save recipe')?.disabled && document.querySelector('.recipe-success'), 'save complete');
    check(writes.length === 1 && writes[0].body.ingredients.some(item => item.stockItemId === rice.id && item.qtyPerSale === 0.275), 'Double submit sends one converted recipe write');
    check(rows().length === 4 && button('Save recipe')?.disabled, 'Save keeps editor open and clears dirty state');
    await fill(quantity(1), '280'); const base = await saved();
    await api(`/products/${dish.id}/recipe`, 'PUT', { expectedVersion: base.version, ingredients: base.links.map(link => ({ stockItemId: link.stockItemId, qtyPerSale: link.stockItemId === rice.id ? 0.3 : link.qtyPerSale })) });
    await delay(150); await click('Save recipe');
    await wait(() => button('Load latest recipe'), 'conflict recovery');
    check(writes.at(-1).status === 409 && quantity(1).value === '280', 'External update and stale save retain the draft');
    window.confirm = () => false; await click('Load latest recipe'); check(quantity(1).value === '280', 'Declining conflict reload keeps draft');
    window.confirm = () => true; await click('Load latest recipe'); await wait(() => quantity(1)?.value === '300' && button('Save recipe')?.disabled, 'latest version');
    check(true, 'Confirmed conflict reload loads latest quantities');
    await remove(2); check(rows().length === 3 && rows()[1].textContent.includes('Salt'), 'Removing a middle row preserves remaining ingredient identities');
    await save(); await add('Oil', 20); await save();
    check((await saved()).links.find(link => link.stockItemId === oil.id).qtyPerSale === 0.02, 'Removed ingredient can be added back and converted');
    await choose(other.name); check(rows().length === 0, 'New product has a clear empty recipe state');
    await add('Rice', 100); await save();
    const beforeBalances = (await api('/stock-items')).items;
    const { order: opened } = await api('/orders', 'POST', { clientRef: crypto.randomUUID(), type: 'parcel' });
    const { order } = await api(`/orders/${opened.id}/items`, 'POST', { items: [{ productId: dish.id, variantId: dish.variants[0].id, qty: 2, clientRef: crypto.randomUUID() }] });
    await api(`/orders/${order.id}/send`, 'POST');
    const afterBalances = (await api('/stock-items')).items;
    const recipeAtSale = await saved();
    check(recipeAtSale.links.every(link => Math.abs(beforeBalances.find(item => item.id === link.stockItemId).qty - afterBalances.find(item => item.id === link.stockItemId).qty - link.qtyPerSale * 2) < 0.000001), 'Variant kitchen send deducts the saved normalized recipe quantities');
    await choose(dish.name); await fill(quantity(1), '350'); await save();
    await api(`/order-items/${order.items[0].id}/cancel`, 'POST', { reason: 'Recipe workflow verification' });
    const reversed = (await api('/stock-items')).items;
    check(recipeAtSale.links.every(link => reversed.find(item => item.id === link.stockItemId).qty === beforeBalances.find(item => item.id === link.stockItemId).qty), 'Cancellation after recipe edit restores original deduction quantities');
    await api('/license', 'PUT', { license: fixture.basic }); window.dispatchEvent(new Event('forkflow:license-changed'));
    await wait(() => document.querySelector('.recipe-access-note')?.textContent.includes('view-only'), 'Basic multi ingredient lock');
    check(quantity(1).disabled && !button('Save recipe'), 'Basic retains readable multi-ingredient recipes without edit controls');
    await choose(other.name); await fill(quantity(1), '125'); await save();
    check(writes.at(-1).path.endsWith('/stock-links') && writes.at(-1).body.qtyPerSale === 0.125 && button('Add ingredient').disabled, 'Basic single ingredient uses the existing stock-link API');
    await api('/license', 'PUT', { license: fixture.pro }); window.dispatchEvent(new Event('forkflow:license-changed'));
    await wait(() => !document.querySelector('.recipe-access-note'), 'Pro upgrade');
    failLoad = true; await click(dish.name); await wait(() => button('Retry loading recipe'), 'load error');
    check(!quantity(1), 'Failed initial load has retry without an editable stale recipe');
    await click('Retry loading recipe'); await wait(() => quantity(1) && !quantity(1).disabled, 'load retry');
    while (rows().length) await remove(rows().length);
    window.confirm = () => false; const beforeClear = writes.length; await click('Save recipe'); check(writes.length === beforeClear && rows().length === 0, 'Declining clear keeps saved recipe and empty draft');
    window.confirm = () => true; await save(); check((await saved()).links.length === 0, 'Confirmed clear removes recipe without leaving editor');
    await add('Rice', 250); await add('Oil', 15); await add('Salt', 2); await save();
    await click('Log out'); await fill(field('Staff PIN'), '2345'); await click('OK'); await wait(() => button('inventory'), 'cashier login');
    await click('inventory'); await click('Recipes'); await choose(dish.name);
    check(quantity(1).disabled && !button('Add ingredient') && !button('Save recipe'), 'Cashier has read-only recipe access');
    await click('Log out'); await fill(field('Staff PIN'), '1234'); await click('OK'); await wait(() => button('inventory'), 'admin login');
    await click('inventory'); await click('Recipes'); await choose(dish.name);
    check(document.body.scrollWidth === window.innerWidth, 'Desktop recipe layout has no horizontal overflow');
    window.__m7Report = { status: 'passed', checks, writes, productName: dish.name }; return window.__m7Report;
  } catch (error) { window.__m7Report = { status: 'failed', checks, error: String(error), writes }; throw error; }
  finally { window.fetch = originalFetch; window.confirm = originalConfirm; window.alert = originalAlert; }
})()