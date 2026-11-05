// Staff activity gate. Start `node --import tsx tools/e2e/staff-activity-server.mts` (fresh each run), open
// http://127.0.0.1:4159/, sign in as admin / admin-password, then add this file to the page.
// Result: window.__staffActivityResult. Drives Reports → Staff activity and Settings → Staff activity alerts.
(async () => {
  if (location.origin !== 'http://127.0.0.1:4159') throw new Error('Disposable http://127.0.0.1:4159 only');
  const checks = [];
  window.__staffActivityProgress = checks;
  const pause = (ms = 80) => new Promise((r) => setTimeout(r, ms));
  const check = (ok, label) => { if (!ok) throw new Error(label); checks.push(label); };
  const wait = async (fn, label) => {
    const until = Date.now() + 15000;
    while (Date.now() < until) { const v = await fn(); if (v) return v; await pause(); }
    throw new Error('Timed out: ' + label + '. Page: ' + document.body.innerText.slice(-800));
  };
  const nav = (label) => wait(() => document.querySelector(`button.nav-item[aria-label="${label}"]`), label).then((b) => b.click());
  const rowsOf = (title) => {
    const region = document.querySelector(`.sales-report-table[aria-label="${title}"]`);
    if (!region) return null;
    const headers = [...region.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    return [...region.querySelectorAll('tbody tr')].map((tr) => Object.fromEntries([...tr.children].map((cell, i) => [headers[i], cell.textContent.trim()])));
  };
  const whys = () => (rowsOf('Flagged') ?? []).map((row) => `${row.Staff}: ${row['Why flagged']}`).sort();
  const openReport = async () => {
    await nav('Reports & Analytics');
    const select = await wait(() => document.querySelector('select[aria-label="More reports"]'), 'More reports');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'staff-activity');
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return select;
  };
  const setValue = (input, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); };
  const api = async (method, path, body) => (await fetch(path, { method, headers: { authorization: 'Bearer ' + localStorage.getItem('masalapos.token'), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })).json();
  const realCreate = URL.createObjectURL;
  let csvBlob = null;
  URL.createObjectURL = (blob) => { csvBlob = blob; return realCreate.call(URL, blob); };
  const defaults = (await api('GET', '/api/settings/activity-alerts')).thresholds;

  try {
    const select = await openReport();
    check([...select.options].some((o) => o.value === 'staff-activity' && o.textContent === 'Staff activity'), 'Staff activity is listed for admins');
    await wait(() => rowsOf('Flagged')?.length, 'Flagged table');
    check(JSON.stringify(whys()) === JSON.stringify(['Asha: Discount of 20% or more', 'Meena: Cash short by ₹200.00 or more', 'Meena: Paid bill voided', 'Meena: Pay-out over ₹500.00', 'Ravi: 2× usual or more']),
      'flags the paid void, cash short, pay-out, 30% discount and Ravi\'s unusual cancellations');
    const ravi = rowsOf('Flagged').find((row) => row.Staff === 'Ravi');
    check(ravi.What === 'Cancelled after KOT' && /^4 items in \d+ days?; usually 0.03 a day/.test(ravi.Detail), 'Ravi\'s flag says 4 items in the chosen days against his usual 0.03 a day');
    const voided = rowsOf('Flagged').find((row) => row['Why flagged'] === 'Paid bill voided');
    check(/Wrong order.*approved by Asha/.test(voided.Detail) && /^Bill #/.test(voided.Reference), 'the void names who approved it and the bill');
    const meena = rowsOf('By staff').find((row) => row.Staff === 'Meena');
    check(meena['Flags'] === '3' && /300/.test(meena['Cash short']) && /600/.test(meena['Pay-outs']), 'By staff totals Meena\'s cash short, pay-outs and flags');
    [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Export CSV' && !b.disabled).click();
    await wait(() => csvBlob, 'CSV');
    const csv = await csvBlob.text();
    check(csv.includes('Paid bill voided') && csv.includes('Ravi') && csv.includes('By staff'), 'the CSV export has the flags and the per-person table');

    await nav('settings');
    (await wait(() => [...document.querySelectorAll('main button, button')].find((b) => b.textContent.trim().startsWith('Restaurant profile')), 'Restaurant profile')).click();
    const legend = await wait(() => [...document.querySelectorAll('legend')].find((l) => l.textContent === 'Staff activity alerts'), 'Staff activity alerts settings');
    const box = legend.closest('fieldset');
    const cash = [...box.querySelectorAll('label')].find((l) => l.textContent.startsWith('Cash short')).querySelector('input');
    check(cash.value === '200', 'Settings shows the ₹200 cash-short default');
    setValue(cash, '500');
    [...box.querySelectorAll('button')].find((b) => b.textContent === 'Save limits').click();
    await wait(() => box.textContent.includes('Saved ✓'), 'limits saved');
    await openReport();
    await wait(() => rowsOf('Flagged') && !whys().includes('Meena: Cash short by ₹200.00 or more'), 'report reloaded');
    check(!whys().some((w) => w.includes('Cash short')), 'with a ₹500 limit, the ₹300 short drawer is no longer flagged');

    window.__staffActivityResult = { status: 'passed', passed: checks.length, checks };
  } catch (error) {
    window.__staffActivityResult = { status: 'failed', error: String(error && error.message || error), checks };
  } finally {
    URL.createObjectURL = realCreate;
    await api('PUT', '/api/settings/activity-alerts', defaults);
  }
  return window.__staffActivityResult;
})();
