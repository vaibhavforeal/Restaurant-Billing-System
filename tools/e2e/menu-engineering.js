// Menu engineering gate. Start `node --import tsx tools/e2e/menu-engineering-server.mts` (fresh each run), open
// http://127.0.0.1:4157/, sign in as admin / admin-password, then add this file to the page.
// Result: window.__menuEngineeringResult. Drives the real Reports screen and captures the CSV export.
(async () => {
  if (location.origin !== 'http://127.0.0.1:4157') throw new Error('Disposable http://127.0.0.1:4157 only');
  const checks = [];
  window.__menuEngineeringProgress = checks;
  const pause = (ms = 80) => new Promise((r) => setTimeout(r, ms));
  const check = (ok, label) => { if (!ok) throw new Error(label); checks.push(label); };
  const wait = async (fn, label) => {
    const until = Date.now() + 15000;
    while (Date.now() < until) { const v = await fn(); if (v) return v; await pause(); }
    throw new Error('Timed out: ' + label + '. Page: ' + document.body.innerText.slice(-800));
  };
  const rowsOf = (title) => {
    const region = document.querySelector(`.sales-report-table[aria-label="${title}"]`);
    if (!region) return null;
    const headers = [...region.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    return [...region.querySelectorAll('tbody tr')].map((tr) => Object.fromEntries([...tr.children].map((cell, i) => [headers[i], cell.textContent.trim()])));
  };
  const realCreate = URL.createObjectURL;
  let csvBlob = null;
  URL.createObjectURL = (blob) => { csvBlob = blob; return realCreate.call(URL, blob); };

  try {
    const nav = await wait(() => document.querySelector('button.nav-item[aria-label="Reports & Analytics"]'), 'Reports nav');
    nav.click();
    const select = await wait(() => document.querySelector('select[aria-label="More reports"]'), 'More reports');
    check([...select.options].some((o) => o.value === 'menu-engineering' && o.textContent === 'Menu engineering'), 'Menu engineering is listed next to Food cost & profit');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'menu-engineering');
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(() => [...document.querySelectorAll('h3')].some((h) => h.textContent === 'Menu engineering'), 'report heading');
    const mains = await wait(() => rowsOf('Mains'), 'Mains table');
    const group = Object.fromEntries(mains.map((row) => [row.Dish, row.Group]));
    check(group['Paneer Tikka'] === 'Star' && group['Paneer Bhurji'] === 'Plowhorse' && group['Malai Kofta'] === 'Puzzle' && group['Shahi Paneer'] === 'Dog',
      'Tikka is a Star, Bhurji a Plowhorse, Kofta a Puzzle and Shahi Paneer a Dog');
    check(group.Water === 'Needs a recipe cost', 'Water, with no recipe, needs a recipe cost');
    const tikka = mains.find((row) => row.Dish === 'Paneer Tikka');
    check(tikka['Plates sold'] === '6' && tikka.Sells === 'High' && /48/.test(tikka['Food cost per plate']) && /52/.test(tikka['Margin per plate'])
      && tikka['Suggested action'] === 'Keep as is and make it easy to find', 'per-plate cost, margin and the suggested action are shown');
    check(mains.map((row) => row.Dish)[0] === 'Paneer Tikka', 'dishes are listed by plates sold');
    const summary = Object.fromEntries((rowsOf('Summary') ?? []).map((row) => [row.Group, row.Dishes]));
    check(summary.Star === '1' && summary.Plowhorse === '1' && summary.Puzzle === '1' && summary.Dog === '1' && summary['Needs a recipe cost'] === '1', 'the summary counts one dish in each group');

    const exportButton = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Export CSV' && !b.disabled);
    exportButton.click();
    await wait(() => csvBlob, 'CSV export');
    const csv = await csvBlob.text();
    check(csv.includes('Menu engineering') || csv.includes('Suggested action'), 'the CSV export has the report');
    check(csv.includes('Paneer Tikka') && csv.includes('Star') && csv.includes('Rework or remove'), 'the CSV has each dish, its group and its action');

    window.__menuEngineeringResult = { status: 'passed', passed: checks.length, checks };
  } catch (error) {
    window.__menuEngineeringResult = { status: 'failed', error: String(error && error.message || error), checks };
  } finally {
    URL.createObjectURL = realCreate;
  }
  return window.__menuEngineeringResult;
})();
