// Run via agent-browser eval --stdin on the disposable, latest-built QA server.
// Sign in and register this browser with a signed Pro license first.
// This gate creates only uniquely named fixtures and refuses all other origins.
(async () => {
  if (location.origin !== 'http://127.0.0.1:4120') throw new Error('Use only the disposable menu QA server on 127.0.0.1:4120');
  const checks = [], writes = [], declined = [], alerts = [];
  const originalFetch = window.fetch, originalConfirm = window.confirm, originalAlert = window.alert;
  const token = localStorage.getItem('forkflow.token'), device = localStorage.getItem('forkflow.device.v1');
  if (!token || !device) throw new Error('Sign in as a registered Pro administrator before this gate');
  const check = (ok, label) => { if (!ok) throw new Error(label); checks.push(label); };
  const pause = (ms = 75) => new Promise((resolve) => setTimeout(resolve, ms));
  const wait = async (fn, label) => {
    const until = Date.now() + 15000;
    while (Date.now() < until) { const result = fn(); if (result) return result; await pause(50); }
    throw new Error('Timed out: ' + label + '. ' + document.body.innerText.slice(-1600));
  };
  const btn = (scope, label) => [...scope.querySelectorAll('button')].find((element) => element.textContent.trim() === label);
  const clickElement = async (find, label) => {
    const element = await wait(() => { const value = find(); return value && !value.disabled && !value.closest('[hidden]') ? value : null; }, label);
    element.click(); await pause();
  };
  const click = (scope, label) => clickElement(() => btn(scope, label), label);
  const editor = () => document.querySelector('[aria-label="Product editor"]');
  const field = (scope, label) => [...scope.querySelectorAll('label')].find((value) => value.textContent.trim().startsWith(label))?.querySelector('input,textarea,select');
  const fillElement = async (find, value, label) => {
    const input = await wait(() => { const input = find(); return input && !input.disabled ? input : null; }, label);
    const view = input.ownerDocument.defaultView;
    const prototype = input.tagName === 'SELECT' ? view.HTMLSelectElement.prototype : input.tagName === 'TEXTAREA' ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, value);
    input.dispatchEvent(new view.Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    await pause();
  };
  const fill = (scope, label, value) => fillElement(() => field(scope, label), value, label);
  const headers = { authorization: 'Bearer ' + token, 'x-forkflow-device': device, 'content-type': 'application/json' };
  const api = async (path, method = 'GET', body) => {
    const response = await originalFetch.call(window, '/api' + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = response.status === 204 ? null : await response.json();
    if (!response.ok) throw new Error(method + ' ' + path + ': ' + response.status + ' ' + JSON.stringify(result));
    return result;
  };
  const hexToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (value) => value.toString(16).padStart(2, '0')).join('');
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;right:8px;bottom:8px;width:390px;height:620px;z-index:9000;background:white;border:2px solid #aaa';
  let blockPreviewId = null, previewFailures = 0, holdNextWrite = false, releaseWrite = null;
  window.fetch = async function (...args) {
    const url = new URL(args[0] instanceof Request ? args[0].url : String(args[0]), location.href);
    const method = (args[1]?.method ?? (args[0] instanceof Request ? args[0].method : 'GET')).toUpperCase();
    if (method === 'GET' && blockPreviewId && url.pathname === '/api/products/' + blockPreviewId + '/photo') {
      previewFailures++;
      return new Response(JSON.stringify({ error: 'Simulated saved-photo preview failure' }), { status: 503, headers: { 'content-type': 'application/json' } });
    }
    const productWrite = method === 'PATCH' && /^\/api\/products\/[^/]+$/.test(url.pathname);
    if (productWrite && holdNextWrite) { holdNextWrite = false; await new Promise((resolve) => { releaseWrite = resolve; }); }
    const response = await originalFetch.apply(window, args);
    if (productWrite) writes.push({ path: url.pathname, status: response.status, body: JSON.parse(args[1].body) });
    return response;
  };
  window.confirm = () => true;
  window.alert = (message) => { alerts.push(message); };
  window.__m9MenuReport = { status: 'running', checks };
  try {
    const [license, me] = await Promise.all([api('/license'), api('/me')]);
    check(license.mode === 'commercial' && license.plan === 'pro' && license.canOperate && license.features.qrOrdering && me.user.role === 'admin', 'Signed Pro administrator and registered browser are ready');
    const suffix = Date.now();
    const { category } = await api('/categories', 'POST', { name: 'Menu gate ' + suffix });
    const { product } = await api('/products', 'POST', { categoryId: category.id, name: 'Menu gate bowl ' + suffix, pricePaise: 18000, gstRate: 5, isVeg: true });
    const { product: portion } = await api('/products', 'POST', { categoryId: category.id, name: 'Menu gate portion ' + suffix, pricePaise: 10000, gstRate: 5,
      variants: [{ name: 'Large', pricePaise: 22000 }, { name: 'Small', pricePaise: 14000 }] });
    const { table } = await api('/tables', 'POST', { name: 'Menu gate table ' + suffix, area: 'QA' });
    const { table: qrTable } = await api('/qr/tables/' + table.id, 'PUT', { enabled: true });
    const qrToken = qrTable.path.split('#')[1];
    const guestLink = location.origin + qrTable.path;
    const { order: opened } = await api('/orders', 'POST', { clientRef: crypto.randomUUID(), type: 'parcel' });
    await api('/orders/' + opened.id + '/items', 'POST', { items: [{ productId: product.id, variantId: null, qty: 1, clientRef: crypto.randomUUID() }] });
    const catalogRow = (name) => [...document.querySelectorAll('.catalog-table-scroll tbody tr')].find((row) => row.querySelector('.catalog-product-name strong')?.textContent === name);
    const savedProduct = async (id = product.id) => (await api('/products')).products.find((value) => value.id === id);
    const savedPhoto = () => api('/products/' + product.id + '/photo');
    const showCatalog = async () => {
      if (btn(document, 'catalog')?.disabled || editor()) await click(document, 'home');
      await click(document, 'catalog');
      await click(document, category.name);
      await wait(() => catalogRow(product.name), 'fixture product in catalog');
    };
    const openEditor = async () => {
      await showCatalog(); await click(catalogRow(product.name), 'Edit');
      await wait(() => editor() && field(editor(), 'Product name')?.value === product.name, 'fixture product editor');
    };
    const finishSave = async (before) => {
      await wait(() => !editor() && writes.length === before + 1, 'one completed UI product save');
      check(writes.at(-1).status === 200, 'Product save is accepted by the real API');
      return savedProduct();
    };
    const saveEditor = async () => { const before = writes.length; await click(editor(), 'Save product'); return finishSave(before); };
    const canvas = document.createElement('canvas'); canvas.width = 1600; canvas.height = 1000;
    const context = canvas.getContext('2d');
    const gradient = context.createLinearGradient(0, 0, 1600, 1000); gradient.addColorStop(0, '#f9d58c'); gradient.addColorStop(1, '#772b20');
    context.fillStyle = gradient; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#fff9ed'; context.beginPath(); context.ellipse(800, 500, 440, 290, 0, 0, Math.PI * 2); context.fill();
    context.fillStyle = '#266847'; context.fillRect(570, 360, 460, 280);
    const fixture = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!fixture || fixture.size > 10 * 1024 * 1024) throw new Error('Could not create the bounded PNG fixture');
    const upload = async (blob, filename, type) => {
      const input = await wait(() => { const input = editor()?.querySelector('input[type="file"]'); return input && !input.disabled ? input : null; }, 'photo upload input');
      const transfer = new DataTransfer(); transfer.items.add(new File([blob], filename, { type }));
      input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(() => editor()?.querySelector('.product-photo-preview')?.src.startsWith('data:image/jpeg;base64,') && !btn(editor(), 'Save product').disabled, 'normalized photo in the unsaved draft');
    };

    await openEditor();
    const description = 'Roasted vegetables, fragrant rice, and a fresh herb dressing.';
    check(field(editor(), 'Menu description').maxLength === 500, 'Menu description input enforces its 500-character limit');
    await fill(editor(), 'Menu description', description);
    await upload(fixture, 'menu-gate.png', 'image/png');
    check((await savedPhoto()).photo === null, 'Selecting a photo does not write it before Save product');
    const beforeHeld = writes.length; holdNextWrite = true;
    await click(editor(), 'Save product');
    await wait(() => releaseWrite, 'held real product write');
    check(field(editor(), 'Menu description').disabled && editor().querySelector('input[type="file"]').disabled && btn(editor(), 'Close').disabled, 'Product fields and closing are disabled while a save is pending');
    await click(document, 'tables');
    check(Boolean(editor()) && alerts.some((message) => message.includes('finish saving')), 'Navigation is blocked while the photo/product write is pending');
    releaseWrite(); releaseWrite = null;
    let saved = await finishSave(beforeHeld);
    const firstPhoto = (await savedPhoto()).photo;
    check(saved.description === description && saved.photoVersion && saved.photoUrl?.endsWith(saved.photoVersion), 'Description and photo metadata persist together');
    check(typeof firstPhoto === 'string' && firstPhoto.startsWith('data:image/jpeg;base64,'), 'PNG upload is stored as a JPEG data URL');
    check(!('photo' in saved) && !('photo_data' in saved) && !JSON.stringify(saved).includes('data:image'), 'Catalog product responses contain photo metadata rather than photo bytes');
    const publicResponse = await originalFetch.call(window, saved.photoUrl, { credentials: 'omit', cache: 'no-store' });
    const publicBlob = await publicResponse.blob();
    const bytes = new Uint8Array(await publicBlob.arrayBuffer());
    check(publicResponse.ok && publicResponse.headers.get('content-type')?.startsWith('image/jpeg') && publicResponse.headers.get('x-content-type-options') === 'nosniff' && bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217, 'Public photo endpoint returns actual JPEG bytes with the correct content type');
    const decoded = await createImageBitmap(publicBlob);
    check(publicBlob.size <= 400 * 1024 && decoded.width === 1200 && decoded.height === 750, 'Upload processing resizes the 1600px fixture and stays within 400 KiB'); decoded.close();
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) => value.toString(16).padStart(2, '0')).join('');
    check(digest === saved.photoVersion, 'Photo URL version matches the saved JPEG content hash');

    iframe.src = guestLink; document.body.append(iframe);
    const guest = await wait(() => iframe.contentDocument?.querySelector('.guest-menu-products') ? iframe.contentDocument : null, 'guest menu for photo preview');
    const guestCard = (name) => [...guest.querySelectorAll('.guest-menu-product')].find((card) => card.querySelector('h3')?.textContent === name);
    const photoCard = await wait(() => guestCard(product.name), 'guest photo card');
    photoCard.scrollIntoView({ block: 'center' });
    await wait(() => photoCard.querySelector('img')?.complete && photoCard.querySelector('img').naturalWidth > 0, 'guest photo decoded');
    check(photoCard.textContent.includes(description) && new URL(photoCard.querySelector('img').src).pathname === saved.photoUrl, 'Guest menu renders the persisted description and local photo');

    await openEditor();
    await wait(() => editor()?.querySelector('.product-photo-preview')?.src === firstPhoto, 'saved photo loaded in editor');
    const dirtyDescription = 'Unsaved description that must survive navigation checks.';
    await fill(editor(), 'Menu description', dirtyDescription);
    const beforeDraft = writes.length;
    window.confirm = (message) => { declined.push(message); return false; };
    await click(document, 'tables');
    check(Boolean(editor()) && field(editor(), 'Menu description').value === dirtyDescription, 'Declining navigation preserves unsaved description and photo draft');
    await click(document, 'Log out');
    check(Boolean(editor()) && localStorage.getItem('forkflow.token') === token && (await api('/me')).user.role === 'admin', 'Declining logout preserves the product draft and staff session');
    await click(editor(), 'Close');
    check(Boolean(editor()) && declined.length === 3 && writes.length === beforeDraft, 'Closing a dirty product also requests confirmation and performs no write');
    window.confirm = () => true; await click(editor(), 'Close');
    await wait(() => !editor(), 'confirmed draft discarded');
    check((await savedProduct()).description === description, 'Discarding changes keeps the stored description unchanged');

    blockPreviewId = product.id;
    await openEditor();
    await wait(() => editor()?.textContent.includes('Saving other details will preserve the saved photo'), 'saved photo load failure');
    const updatedDescription = 'Roasted vegetables and rice, finished with fresh herbs.';
    await fill(editor(), 'Menu description', updatedDescription);
    saved = await saveEditor();
    check(previewFailures > 0 && !Object.hasOwn(writes.at(-1).body, 'photo') && saved.photoVersion === digest && (await savedPhoto()).photo === firstPhoto && saved.description === updatedDescription, 'Saving after preview failure omits photo and preserves the existing saved image');
    blockPreviewId = null;

    await openEditor();
    await wait(() => editor()?.querySelector('.product-photo-preview')?.src === firstPhoto, 'photo restored after failed preview');
    const oldPublicUrl = saved.photoUrl;
    await click(editor(), 'Remove photo');
    check(!editor().querySelector('.product-photo-preview') && (await savedPhoto()).photo === firstPhoto, 'Removing a photo remains an unsaved draft until Save product');
    saved = await saveEditor();
    check(writes.at(-1).body.photo === null && saved.photoVersion === null && saved.photoUrl === null && (await savedPhoto()).photo === null, 'Explicit photo removal clears stored bytes and metadata');
    check((await originalFetch.call(window, oldPublicUrl, { credentials: 'omit', cache: 'no-store' })).status === 404, 'Removed photo content is no longer served at its old URL');
    await openEditor(); await upload(publicBlob, 'menu-gate.jpg', 'image/jpeg'); saved = await saveEditor();
    check(saved.photoVersion && saved.description === updatedDescription, 'JPEG upload restores a photo while retaining the description');

    const toggle = async (name, soldOut) => {
      await clickElement(() => catalogRow(name)?.querySelector('button[aria-label="Mark ' + name + ' ' + (soldOut ? 'sold out' : 'available') + '"]'), 'quick availability toggle for ' + name);
      await wait(() => catalogRow(name)?.querySelector('.catalog-availability > span')?.textContent === (soldOut ? 'Sold out' : 'Available') && !catalogRow(name).querySelector('.catalog-availability button').disabled, 'saved availability for ' + name);
    };
    await showCatalog(); await toggle(product.name, true); await toggle(portion.name, true);
    check((await savedProduct()).isSoldOut && (await savedProduct()).isActive && (await savedProduct(portion.id)).isSoldOut, 'Quick sold-out actions keep both products active and visible');
    await click(guest, 'Refresh menu');
    await wait(() => guestCard(product.name)?.querySelector('.guest-menu-soldout') && guestCard(portion.name)?.querySelector('.guest-menu-soldout'), 'guest sold-out refresh');
    check(guestCard(product.name).querySelector('button').disabled && guestCard(portion.name).querySelector('button').disabled && guestCard(product.name).textContent.includes(updatedDescription), 'Guest menu shows sold-out dishes and disables base and variant additions');
    const menuResponse = await originalFetch.call(window, '/api/guest/menu', { headers: { 'x-qr-token': qrToken }, credentials: 'omit' });
    const guestMenu = await menuResponse.json();
    const blocked = await originalFetch.call(window, '/api/guest/requests', { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json', 'x-qr-token': qrToken }, body: JSON.stringify({
      clientRef: crypto.randomUUID(), receiptToken: hexToken(), menuVersion: guestMenu.menuVersion, items: [{ productId: product.id, variantId: null, qty: 1, note: '' }],
    }) });
    check(blocked.status === 409 && !(await api('/qr/requests')).requests.some((request) => request.tableId === table.id), 'Server rejects a crafted sold-out request without storing a guest request');

    const showStaffMenu = async () => {
      await click(document, 'tables');
      await click(document, 'Parcel ' + opened.clientRef.slice(0, 8));
      await wait(() => document.querySelector('.menu-browser'), 'staff product menu');
      await click(document, 'All items');
      await fillElement(() => document.querySelector('[aria-label="Search menu"]'), 'Menu gate', 'staff menu search');
    };
    const staffCard = (name) => [...document.querySelectorAll('.menu-card')].find((card) => card.querySelector('.menu-card-name')?.textContent === name);
    await showStaffMenu();
    await wait(() => staffCard(product.name) && staffCard(portion.name), 'both sold-out staff cards');
    check(staffCard(product.name).disabled && staffCard(product.name).textContent.includes('Sold out') && [...staffCard(portion.name).querySelectorAll('.variant-choice')].every((button) => button.disabled), 'Staff menu keeps sold-out cards visible and disables base and variant add buttons');
    const existing = (await api('/orders/' + opened.id)).order;
    check(existing.items.length === 1 && existing.items[0].productId === product.id && existing.items[0].status === 'pending', 'Marking sold out leaves existing punched order items unchanged');
    await showCatalog(); await toggle(product.name, false); await toggle(portion.name, false);
    await click(guest, 'Refresh menu');
    await wait(() => guestCard(product.name)?.querySelector('button') && !guestCard(product.name).querySelector('button').disabled && !guestCard(portion.name).querySelector('button').disabled, 'guest availability restored');
    check(!guestCard(product.name).querySelector('.guest-menu-soldout') && !(await savedProduct()).isSoldOut, 'Restoring availability re-enables guest additions');
    await showStaffMenu();
    await wait(() => staffCard(product.name) && !staffCard(product.name).disabled && [...staffCard(portion.name).querySelectorAll('.variant-choice')].every((button) => !button.disabled), 'staff availability restored');
    check(true, 'Restoring availability re-enables staff base and variant add controls');

    await openEditor();
    await wait(() => editor()?.querySelector('.product-photo-preview')?.complete && editor().querySelector('.product-photo-preview').naturalWidth > 0, 'final saved product preview');
    check(field(editor(), 'Menu description').value === updatedDescription && !editor().querySelector('.product-editor-heading [role="status"]').textContent, 'Final editor reopens the saved description and photo without a dirty draft');
    editor().scrollIntoView({ block: 'start', behavior: 'instant' });
    window.__m9MenuReport = { status: 'passed', checks, productId: product.id, productName: product.name, variantProductId: portion.id,
      categoryId: category.id, tableId: table.id, orderId: opened.id, guestLink, previewFailures,
      uiWrites: writes.map((write) => ({ path: write.path, status: write.status, fields: Object.keys(write.body), photo: Object.hasOwn(write.body, 'photo') ? write.body.photo === null ? 'removed' : 'replaced' : 'preserved' })) };
    return window.__m9MenuReport;
  } catch (error) {
    window.__m9MenuReport = { status: 'failed', checks, error: error instanceof Error ? error.message : String(error), previewFailures,
      uiWrites: writes.map((write) => ({ path: write.path, status: write.status, fields: Object.keys(write.body) })) };
    throw error;
  } finally {
    if (releaseWrite) releaseWrite();
    iframe.remove(); window.fetch = originalFetch; window.confirm = originalConfirm; window.alert = originalAlert;
  }
})()
