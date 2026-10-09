// Run on licensing-server.mts after browser setup and loading browser-fixtures.js.
(async () => {
  if (location.origin !== 'http://127.0.0.1:4128' || !window.__licenseFixtures) throw new Error('Use the disposable commercial server and its fixtures.');
  const fixtures = window.__licenseFixtures, checks = [], downloads = [], blobs = new Map();
  const check = (ok, label) => { if (!ok) throw new Error(label); checks.push(label); };
  const wait = async (fn) => { const end = Date.now() + 12000; while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 30)); } throw new Error('Timed out: ' + document.body.innerText.slice(-2000)); };
  const tick = () => new Promise((r) => setTimeout(r, 60));
  const panel = () => document.querySelector('.license-settings');
  const button = (name) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === name || b.getAttribute('aria-label') === name);
  const click = async (name) => { await wait(() => button(name) && !button(name).disabled); button(name).click(); await tick(); };
  const input = (name) => [...panel().querySelectorAll('label')].find((l) => l.textContent.startsWith(name))?.querySelector('input,textarea');
  const set = async (el, value) => { Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); await tick(); };
  const choose = async (text, name = 'license.txt') => { const el = document.querySelector('[aria-label="License file"]'), transfer = new DataTransfer(); transfer.items.add(new File([text], name, { type: 'text/plain' })); el.files = transfer.files; el.dispatchEvent(new Event('change', { bubbles: true })); await tick(); };
  const alertHas = (text) => [...document.querySelectorAll('[role="alert"]')].some((el) => el.textContent.includes(text));
  const originalFetch = window.fetch, originalUrl = URL.createObjectURL, originalClick = HTMLAnchorElement.prototype.click, originalConfirm = window.confirm, originalAlert = window.alert;
  const headers = () => ({ authorization: 'Bearer ' + localStorage.getItem('forkflow.token'), 'x-forkflow-device': localStorage.getItem('forkflow.device.v1'), 'content-type': 'application/json' });
  const api = async (path, method = 'GET', body, as = headers()) => {
    const res = await originalFetch('/api' + path, { method, headers: as, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (res.status === 204) return {};
    const value = await res.json(); if (!res.ok) throw new Error(JSON.stringify(value)); return value;
  };
  const registerOther = async (credential, name) => {
    const login = await api('/login', 'POST', { pin: '1234' }, { 'x-forkflow-device': credential, 'content-type': 'application/json' });
    const as = { authorization: 'Bearer ' + login.token, 'x-forkflow-device': credential, 'content-type': 'application/json' };
    await api('/license/devices', 'POST', { name }, as); return as;
  };
  URL.createObjectURL = function (blob) { const url = originalUrl.call(this, blob); blobs.set(url, blob); return url; };
  HTMLAnchorElement.prototype.click = function () { if (blobs.has(this.href)) downloads.push({ filename: this.download, text: blobs.get(this.href).text() }); return originalClick.call(this); };
  let release = () => {};
  try {
    await wait(() => panel() && !button('Refresh plan').disabled);
    check((await api('/license')).state === 'unactivated' && !!button('Back up now'), 'Unactivated installation provides activation and backup recovery');
    check((await originalFetch('/api/products', { headers: headers() })).status === 403, 'Commercial operations require activation');
    document.querySelector('.license-identity').open = true;
    await click('Download activation request'); await wait(() => downloads.length === 1);
    const request = JSON.parse(await downloads[0].text);
    check(request.installationId === fixtures.installationId && request.currentRevision === 0 && !('envelope' in request), 'Activation request download contains this installation and no signed grant');
    await choose('x'.repeat(16385)); await wait(() => alertHas('16 KB'));
    check(!input('Signed license').value, 'Oversized license files are rejected before upload');
    await choose('ff1.bad.bad'); await click('Preview license'); await wait(() => alertHas('License is invalid'));
    check((await api('/license')).state === 'unactivated', 'Invalid signatures cannot change activation');
    await choose('\uFEFF' + fixtures.pro + '\r\n'); await click('Preview license'); await wait(() => !!document.querySelector('.license-preview'));
    check(document.querySelector('.license-preview').innerText.includes('5 devices') && (await api('/license')).state === 'unactivated', 'UTF-8 license file previews verified entitlements without saving');
    let requested = false, dropped = false, alerts = 0;
    const hold = new Promise((r) => { release = r; });
    window.alert = () => { alerts++; };
    window.fetch = async (...args) => {
      if (String(args[0]) === '/api/license' && args[1]?.method === 'PUT' && !dropped) {
        requested = true; await hold; const res = await originalFetch(...args); await res.clone().json(); dropped = true;
        throw new TypeError('Simulated lost activation acknowledgement');
      }
      return originalFetch(...args);
    };
    await click('Apply license'); await wait(() => requested);
    check(button('Apply license').disabled && button('Preview license').disabled, 'Applying a license blocks duplicate changes');
    document.querySelector('nav button[aria-label="tables"]').click();
    check(alerts === 1, 'Navigation waits for an in-flight activation');
    release(); await wait(() => alertHas('Simulated lost activation acknowledgement'));
    window.fetch = originalFetch; await click('Apply license');
    await wait(() => !input('Signed license').value && !button('Refresh plan').disabled);
    check((await api('/license/history')).events.filter((e) => e.kind === 'license_activated').length === 1, 'Retry after a lost acknowledgement records activation once');
    await set(input('Device name'), 'Main counter'); await click('Register this device');
    await wait(() => document.body.innerText.includes('Dashboard'));
    check((await api('/license')).canOperate, 'Registering this browser unlocks the restaurant workspace');
    document.querySelector('nav button[aria-label="settings"]').click(); await wait(() => document.querySelector('[data-section="plan"]')); document.querySelector('[data-section="plan"]').click(); await wait(() => panel() && !button('Refresh plan').disabled);
    await registerOther('b'.repeat(64), 'Kitchen'); const phoneHeaders = await registerOther('c'.repeat(64), 'Waiter phone');
    await click('Refresh plan'); await wait(() => panel().innerText.includes('Waiter phone'));
    check(panel().innerText.includes('3 / 5'), 'Plan summary uses the registered device count');
    await click('Rename Waiter phone'); await set(input('New device name'), 'Dining phone'); await click('Save device name');
    await wait(() => panel().innerText.includes('Dining phone') && !input('New device name'));
    check((await api('/license/devices')).devices.some((d) => d.name === 'Dining phone' && d.version === 2), 'Admin can rename another device without using its browser');
    await choose(fixtures.basic); await click('Preview license'); await wait(() => document.querySelector('.license-preview')?.innerText.includes('Dining phone'));
    check((await api('/license')).plan === 'pro' && document.querySelector('.license-preview').innerText.includes('will be blocked'), 'Downgrade preview identifies the device that would lose access');
    const kitchen = (await api('/license/devices')).devices.find((d) => d.name === 'Kitchen');
    await api('/license/devices/' + kitchen.id, 'PATCH', { name: 'Kitchen screen', version: kitchen.version });
    await click('Apply license'); await wait(() => alertHas('devices changed'));
    check((await api('/license')).revision === 1, 'Device changes invalidate a previously reviewed license preview');
    await click('Preview license'); await click('Apply license');
    await wait(() => panel().innerText.includes('3 / 2') && !button('Refresh plan').disabled);
    check((await originalFetch('/api/products', { headers: phoneHeaders })).status === 403, 'Downgrade blocks excess devices on the API');
    window.confirm = () => true;
    await click('Remove Dining phone'); await wait(() => !(panel().querySelector('.license-devices')?.innerText.includes('Dining phone')) && !button('Refresh plan').disabled);
    check((await originalFetch('/api/me', { headers: phoneHeaders })).status === 401, 'Removing a device revokes its staff sessions');
    await choose(fixtures.basic); await click('Preview license'); await wait(() => document.querySelector('.license-preview')?.innerText.includes('already installed'));
    check(!button('Apply license'), 'An already-installed file is identified without another activation');
    await click('Clear license');
    await choose(fixtures.upgrade); await click('Preview license'); await click('Apply license');
    await wait(() => (panel()?.innerText.includes('2 / 5')) && !button('Refresh plan').disabled);
    check((await api('/license')).revision === 3, 'A higher signed revision upgrades the plan');
    window.fetch = async (...args) => String(args[0]) === '/api/license/devices' && !args[1]?.method
      ? new Response(JSON.stringify({ error: 'Device list unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } }) : originalFetch(...args);
    await click('Refresh plan'); await wait(() => alertHas('Device list unavailable'));
    check(!panel().querySelector('.license-devices li') && button('Register this device').disabled, 'Failed refresh removes stale device actions');
    window.fetch = originalFetch; await click('Refresh plan'); await wait(() => !!panel().querySelector('.license-devices li'));
    check(!alertHas('Device list unavailable'), 'Device management recovers after a failed refresh');
    const history = (await api('/license/history')).events;
    check(history.some((e) => e.kind === 'device_removed') && history.some((e) => e.kind === 'device_renamed') && history.every((e) => e.actorName === 'QA Admin'), 'History records activation and device changes with the acting administrator');
    window.__licenseChecks = { status: 'passed', checks };
    return window.__licenseChecks;
  } finally { release(); window.fetch = originalFetch; URL.createObjectURL = originalUrl; HTMLAnchorElement.prototype.click = originalClick; window.confirm = originalConfirm; window.alert = originalAlert; }
})();
