// Bill settings gate. Run a disposable copy: `MASALAPOS_PORT=4200 MASALAPOS_DATA_DIR=./data-billset npx tsx apps/server/src/main.ts`, POST /api/setup
// (admin / admin-password), `MASALAPOS_PORT=4200 npm run dev -w @masalapos/ui -- --port 5190 --strictPort`, open http://localhost:5190/, sign in, then
// add this file to the page. It saves settings and reloads the page: add the file again after the reload for the second half.
// Result: window.__billSettingsResult (7 checks across both runs; the first run reports "reloading"). Drives Settings -> Bill settings and AI suggestions; restores the defaults at the end.
(async () => {
  if (location.origin !== 'http://localhost:5190') throw new Error('Disposable http://localhost:5190 only');
  const checks = [];
  window.__billSettingsProgress = checks;
  const pause = (ms = 80) => new Promise((r) => setTimeout(r, ms));
  const check = (ok, label) => { if (!ok) throw new Error(label); checks.push(label); };
  const wait = async (fn, label, ms = 15000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { const v = await fn(); if (v) return v; await pause(); }
    throw new Error('Timed out: ' + label + '. Page: ' + document.body.innerText.slice(-800));
  };
  const nav = (label) => wait(() => document.querySelector(`button.nav-item[aria-label="${label}"]`), label).then((b) => b.click());
  const card = (title) => [...document.querySelectorAll('button.settings-card')].find((b) => b.querySelector('.settings-card-title')?.textContent === title);
  const openCard = async (title) => {
    if (!card(title)) { const back = [...document.querySelectorAll('.settings-detail-head button')][0]; if (back) back.click(); }
    (await wait(() => card(title), title + ' card')).click();
  };
  const label = (text) => [...document.querySelectorAll('label')].find((l) => l.textContent.trim().startsWith(text));
  const setValue = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const fssai = () => label('Show FSSAI number').querySelector('input');
  const frameText = () => document.querySelector('iframe[title="Bill preview"]')?.contentDocument?.body?.innerText ?? '';

  try {
    await nav('settings');
    await wait(() => card('Bill settings') && card('AI suggestions'), 'Bill settings and AI suggestions cards');
    if (sessionStorage.billSettingsPhase !== '2') {
      check(true, 'Settings lists the Bill settings and AI suggestions cards');
      await openCard('Bill settings');
      const header = await wait(() => label('Header lines')?.querySelector('textarea'), 'header lines');
      await wait(() => frameText().length > 0, 'first preview');
      check(!frameText().includes('Pure veg'), 'the preview starts without the header text');
      setValue(header, 'Pure veg');
      await wait(() => frameText().includes('Pure veg'), 'preview shows Pure veg', 2000);
      check(true, 'typing a header line updates the preview within 2 s');
      check(fssai().checked, 'Show FSSAI number is on by default');
      fssai().click();
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'Save').click();
      await wait(() => document.body.innerText.includes('Saved'), 'saved');
      check(true, 'Save shows Saved');
      sessionStorage.billSettingsPhase = '2';
      window.__billSettingsResult = { status: 'reloading', checks };
      setTimeout(() => location.reload(), 200);
      return window.__billSettingsResult;
    }
    sessionStorage.removeItem('billSettingsPhase');
    await openCard('Bill settings');
    await wait(() => label('Show FSSAI number'), 'form after reload');
    check(!fssai().checked && label('Header lines').querySelector('textarea').value === 'Pure veg', 'after a reload the FSSAI box is still unticked and the header is saved');
    // restore the defaults
    fssai().click();
    setValue(label('Header lines').querySelector('textarea'), '');
    [...document.querySelectorAll('button')].find((b) => b.textContent === 'Save').click();
    await wait(() => document.body.innerText.includes('Saved'), 'defaults restored');
    await openCard('AI suggestions');
    await wait(() => label('Show popular items'), 'Show popular items');
    check(!!label('Show popular items').querySelector('input[type="checkbox"]'), 'AI suggestions has the Show popular items checkbox');
    window.__billSettingsResult = { status: 'passed', passed: checks.length, checks };
  } catch (error) {
    window.__billSettingsResult = { status: 'failed', error: String(error && error.message || error), checks };
  }
  return window.__billSettingsResult;
})();
