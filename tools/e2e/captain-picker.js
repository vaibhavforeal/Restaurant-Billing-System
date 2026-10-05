// Run on an open dine-in order in the disposable captain-server.mts fixture.
(async () => {
  if (location.port !== "4139") throw Error("Captain fixture on port 4139 required");
  const checks = [], originalFetch = window.fetch;
  const pause = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async fn => { const end = Date.now() + 10000; while (Date.now() < end) { if (fn()) return; await pause(); } throw Error("Wait timed out"); };
  const check = (ok, text) => { if (!ok) throw Error(text); checks.push(text); };
  const trigger = () => document.querySelector('[aria-label="Captain for this order"]');
  const dialog = () => document.querySelector('.order-captain-dialog[open]');
  const choice = name => [...dialog().querySelectorAll('.order-captain-options button')].find(button => button.firstElementChild.textContent === name);
  const open = async () => { await wait(() => trigger() && !trigger().disabled); trigger().click(); await wait(dialog); };
  const select = async name => { choice(name).click(); await wait(() => !dialog() && !trigger().disabled); };
  let failed = false, delay = false, requests = 0, lastPath;
  const api = async path => {
    const response = await originalFetch(path, { headers: { authorization: `Bearer ${localStorage.getItem('forkflow.token')}`, 'x-forkflow-device': localStorage.getItem('forkflow.device.v1') } });
    if (!response.ok) throw Error(await response.text()); return response.json();
  };
  window.fetch = async (...args) => {
    const path = new URL(String(args[0]), location.href).pathname;
    if (path.endsWith('/captain') && args[1]?.method === 'PATCH') {
      requests++; lastPath = path;
      if (delay) await pause(350);
      if (failed) { failed = false; return new Response(JSON.stringify({ error: 'Captain save failed. Please retry.' }), { status: 503 }); }
    }
    return originalFetch(...args);
  };
  try {
    await open();
    check(dialog().contains(document.activeElement), 'Focus enters the captain dialog');
    check(!!choice('Ravi') && !document.querySelector('.order-captain-picker select'), 'Active captain is a button without a native dropdown');
    await select('No captain');
    await open();
    failed = true; choice('Ravi').click();
    await wait(() => dialog()?.querySelector('[role="alert"]') && !trigger().disabled);
    check(dialog().textContent.includes('Captain save failed') && trigger().textContent.includes('Select captain'), 'Failed save stays in the picker and preserves the confirmed assignment');
    const beforeRetry = requests; delay = true;
    choice('Ravi').click(); choice('Ravi').click();
    await wait(() => dialog()?.querySelector('[aria-busy="true"]'));
    check([...dialog().querySelectorAll('button')].every(button => button.disabled), 'Saving locks choices and closing to prevent duplicate actions');
    await wait(() => !dialog() && !trigger().disabled); delay = false;
    check(requests === beforeRetry + 1 && trigger().textContent.includes('Ravi'), 'Retry sends one request and displays the saved captain');
    check((await api(lastPath.replace(/\/captain$/, ''))).order.captainName === 'Ravi', 'Captain assignment persists on the server');
    await open();
    check(choice('Ravi').getAttribute('aria-pressed') === 'true', 'Reopening identifies the current captain');
    const beforeSame = requests;
    await select('Ravi');
    check(requests === beforeSame, 'Choosing the current captain closes without a redundant write');
    await open(); await select('No captain');
    check(trigger().textContent.includes('Select captain') && (await api(lastPath.replace(/\/captain$/, ''))).order.captainId === null, 'Removing a captain persists and resets the label');
    await open(); await select('Ravi');
    const back = [...document.querySelectorAll('button')].find(button => button.textContent === '← Tables'); back.click();
    await wait(() => document.querySelector('.table-card')?.textContent);
    check([...document.querySelectorAll('.table-card')].some(card => card.textContent.includes('Captain: Ravi')), 'Tables show the saved captain');
    return checks;
  } finally { window.fetch = originalFetch; }
})()
