// Prep forecast gate. Start `node --import tsx tools/e2e/prep-forecast-server.mts` (fresh each run), open
// http://127.0.0.1:4158/, sign in as admin / admin-password, then add this file to the page.
// Result: window.__prepForecastResult. Drives Inventory → Prep forecast; window.print is replaced while it runs.
(async () => {
  if (location.origin !== 'http://127.0.0.1:4158') throw new Error('Disposable http://127.0.0.1:4158 only');
  const checks = [];
  window.__prepForecastProgress = checks;
  const pause = (ms = 80) => new Promise((r) => setTimeout(r, ms));
  const check = (ok, label) => { if (!ok) throw new Error(label); checks.push(label); };
  const wait = async (fn, label) => {
    const until = Date.now() + 15000;
    while (Date.now() < until) { const v = await fn(); if (v) return v; await pause(); }
    throw new Error('Timed out: ' + label + '. Page: ' + document.body.innerText.slice(-800));
  };
  const panel = () => document.querySelector('#inventory-prep-panel');
  const rows = (titleId) => {
    const table = panel()?.querySelector(`section[aria-labelledby="${titleId}"] table`);
    return table ? [...table.querySelectorAll('tbody tr:not(.prep-category)')].map((tr) => [...tr.children].map((c) => c.textContent.trim())) : [];
  };
  const dishes = () => Object.fromEntries(rows('prep-dishes-title').map(([name, plates, days]) => [name, { plates, days }]));
  const ingredients = () => rows('prep-ingredients-title');
  const choose = (label, value) => {
    const select = [...panel().querySelectorAll('label')].find((l) => l.textContent.startsWith(label)).querySelector('select');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return select;
  };
  const realPrint = window.print;
  let printed = 0;
  window.print = () => { printed++; };

  try {
    (await wait(() => document.querySelector('button.nav-item[aria-label="inventory"]'), 'Inventory nav')).click();
    (await wait(() => document.querySelector('#inventory-prep-tab'), 'Prep forecast tab')).click();
    const day = await wait(() => panel()?.querySelector('select'), 'day picker');
    check(day.selectedOptions[0].textContent.startsWith('Tomorrow'), 'opens on tomorrow');
    await wait(() => dishes()['Paneer tikka'], 'dishes');
    check(/Based on the last 4 /.test(panel().querySelector('.prep-basis').textContent), 'says it is based on the last 4 same weekdays');
    check(dishes()['Paneer tikka'].plates === '3' && dishes()['Paneer tikka'].days === '4 · 2 · 0 · 6', 'Paneer tikka: 3 plates from 4 · 2 · 0 · 6');
    check(dishes().Naan?.plates === '2' && !dishes().Lassi, 'Naan is listed; Lassi, sold on only one of the days, is not');
    const list = ingredients();
    check(list[0][0] === 'Paneer' && list[0][3] === '0.5 kg', 'Paneer comes first: need 0.6 kg, have 0.1 kg, buy 0.5 kg');
    check(list.find((r) => r[0] === 'Curd')?.[3] === 'Enough', 'Curd is enough');
    check(/no recipe.*Naan/.test(panel().textContent), 'Naan is named as having no recipe');

    choose('Safety margin', '10');
    await wait(() => dishes()['Paneer tikka']?.plates === '4', 'margin applied');
    check(ingredients()[0][1] === '0.66 kg' && ingredients()[0][3] === '0.56 kg', '+10% gives 4 plates and 0.66 kg of paneer, 0.56 kg to buy');

    (await wait(() => [...panel().querySelectorAll('button')].find((b) => b.textContent === 'Print' && !b.disabled), 'Print')).click();
    await wait(() => printed === 1, 'print called');
    const sheet = document.querySelector('body > .prep-print-sheet');
    check(document.body.classList.contains('printing-prep') && sheet && /Prep list/.test(sheet.textContent) && sheet.textContent.includes('Paneer tikka'), 'Print shows a prep sheet with the dishes');
    window.dispatchEvent(new Event('afterprint'));
    await wait(() => !document.querySelector('body > .prep-print-sheet') && !document.body.classList.contains('printing-prep'), 'print sheet removed');
    check(true, 'the sheet is removed after printing');

    choose('Day', day.options[0].value);
    await wait(() => panel().textContent.includes('No dish sold on at least 2'), 'today has no history');
    check(true, 'another weekday without sales says so instead of guessing');

    window.__prepForecastResult = { status: 'passed', passed: checks.length, checks };
  } catch (error) {
    window.__prepForecastResult = { status: 'failed', error: String(error && error.message || error), checks };
  } finally {
    window.print = realPrint;
  }
  return window.__prepForecastResult;
})();
