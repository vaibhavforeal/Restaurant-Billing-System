// Run after licensing.js with the disposable server's clock-offset.txt set to 10800000.
(async () => {
  if (location.origin !== 'http://127.0.0.1:4128' || !window.__licenseFixtures) throw new Error('Use the disposable commercial server.');
  const checks = [];
  const check = (ok, label) => { if (!ok) throw new Error(label); checks.push(label); };
  const wait = async (fn) => { const end = Date.now() + 12000; while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 30)); } throw new Error('Timed out: ' + document.body.innerText.slice(-1000)); };
  const button = (name) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === name);
  const click = async (name) => { await wait(() => button(name) && !button(name).disabled); button(name).click(); await new Promise((r) => setTimeout(r, 60)); };
  const headers = { authorization: 'Bearer ' + localStorage.getItem('forkflow.token'), 'x-forkflow-device': localStorage.getItem('forkflow.device.v1'), 'content-type': 'application/json' };
  const api = async (path) => { const res = await fetch('/api' + path, { headers }); if (!res.ok) throw new Error(await res.text()); return res.json(); };
  window.dispatchEvent(new Event('forkflow:license-changed'));
  await wait(() => !!document.querySelector('.license-recovery'));
  check((await api('/license')).state === 'expired', 'Expired license opens the recovery screen');
  check((await fetch('/api/products', { headers })).status === 403, 'Operational APIs pause after offline grace ends');
  check(document.documentElement.scrollWidth <= innerWidth && document.querySelector('.license-settings').getBoundingClientRect().width <= innerWidth, 'Recovery screen fits a phone viewport without horizontal overflow');
  await click('Back up now'); await wait(() => document.body.innerText.includes('Verified local backup saved'));
  check((await api('/system/backups')).backups.length > 0, 'Admin can create a verified database backup after expiry');
  check((await api('/license/history')).events.length > 0, 'Change history remains available during expiry recovery');
  const file = document.querySelector('[aria-label="License file"]'), transfer = new DataTransfer();
  transfer.items.add(new File([window.__licenseFixtures.renewal], 'renewal.lic', { type: 'text/plain' })); file.files = transfer.files; file.dispatchEvent(new Event('change', { bubbles: true }));
  await click('Preview license'); await wait(() => !!document.querySelector('.license-preview'));
  check(document.querySelector('.license-preview').innerText.includes('Revision 4'), 'Expired installations can preview a signed renewal');
  await click('Apply license'); await wait(() => !document.querySelector('.license-recovery'));
  check((await api('/license')).canOperate && (await api('/license')).revision === 4, 'Renewal restores access with existing device registrations');
  check((await fetch('/api/products', { headers })).status === 200, 'Operational APIs resume after renewal');
  check((await api('/license/devices')).devices.length === 2, 'Renewal preserves registered devices');
  const originalFetch = window.fetch;
  let release = () => {}, captured = false, first = true;
  const hold = new Promise((resolve) => { release = resolve; });
  try {
    window.fetch = async (...args) => {
      if (String(args[0]) === '/api/license' && !args[1]?.method && first) {
        first = false; const response = await originalFetch(...args), status = await response.json();
        captured = true; await hold;
        return new Response(JSON.stringify({ ...status, state: 'expired', canOperate: false, message: 'Stale test response' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return originalFetch(...args);
    };
    window.dispatchEvent(new Event('forkflow:license-changed')); await wait(() => captured);
    await click('Refresh plan'); await wait(() => !button('Refresh plan').disabled);
    release(); await new Promise((resolve) => setTimeout(resolve, 150));
    check(!document.querySelector('.license-recovery') && !document.body.innerText.includes('Stale test response'), 'Late license responses cannot overwrite a newer successful check');
  } finally { release(); window.fetch = originalFetch; }
  document.querySelector('.license-settings').scrollIntoView({ block: 'start' });
  window.__licenseRecoveryChecks = { status: 'passed', checks };
  return window.__licenseRecoveryChecks;
})();
