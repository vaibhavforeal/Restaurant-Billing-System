// AI assistant gate. Start `node --import tsx tools/e2e/fake-openrouter.mts`, then `node --import tsx tools/e2e/ai-assistant-server.mts`
// (both fresh each run), open http://127.0.0.1:4160/, sign in as admin / admin-password, then add this file to the page.
// Result: window.__aiAssistantResult. Drives Settings, Reports → Ask MasalaPOS, Day-end and the dish editor.
(async () => {
  if (location.origin !== 'http://127.0.0.1:4160') throw new Error('Disposable http://127.0.0.1:4160 only');
  const FAKE = 'http://127.0.0.1:4161';
  const checks = [];
  window.__aiAssistantProgress = checks;
  const pause = (ms = 80) => new Promise((r) => setTimeout(r, ms));
  const check = (ok, label) => { if (!ok) throw new Error(label); checks.push(label); };
  const wait = async (fn, label, ms = 20000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { const v = await fn(); if (v) return v; await pause(); }
    throw new Error('Timed out: ' + label + '. Page: ' + document.body.innerText.slice(-900));
  };
  const visible = (el) => !!el && el.getClientRects().length > 0 && !el.closest('[inert]');
  const buttons = (root = document) => [...root.querySelectorAll('button')].filter(visible);
  const byText = (text, root = document) => buttons(root).find((b) => b.textContent.trim().startsWith(text) && !b.disabled);
  const click = async (find, label) => { const b = await wait(find, label); b.click(); await pause(250); };
  const nav = (label) => click(() => document.querySelector(`button.nav-item[aria-label="${label}"]`), label);
  const setInput = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  };
  const moreReports = () => document.querySelector('select[aria-label="More reports"]');
  const openAsk = async () => {
    await nav('Reports & Analytics');
    const select = await wait(moreReports, 'More reports');
    setInput(select, 'ask');
    return wait(() => document.querySelector('section[aria-label="Ask MasalaPOS"]'), 'Ask MasalaPOS');
  };
  const askQuestion = async (text) => {
    const input = await wait(() => document.querySelector('input[aria-label="Your question"]'), 'question box');
    setInput(input, text);
    await click(() => byText('Ask', document.querySelector('section[aria-label="Ask MasalaPOS"]')), 'Ask');
  };
  let copied = null;
  const realClipboard = Object.getOwnPropertyDescriptor(Navigator.prototype, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { copied = t; } } });

  try {
    // 1. Hidden until set up.
    await nav('Reports & Analytics');
    const select = await wait(moreReports, 'More reports');
    check(![...select.options].some((o) => o.value === 'ask'), 'Ask MasalaPOS is hidden before the assistant is set up');

    // 2. Settings: save a key, model pre-selected, Test.
    await nav('settings');
    await click(() => buttons().find((b) => b.textContent.trim().startsWith('Restaurant profile')), 'Restaurant profile');
    const box = (await wait(() => [...document.querySelectorAll('legend')].find((l) => l.textContent === 'AI assistant'), 'AI assistant settings')).closest('fieldset');
    const keyInput = await wait(() => box.querySelector('input[type="password"]:not(:disabled)'), 'key input');
    setInput(keyInput, 'sk-or-v1-e2e-test-key-4321');
    await click(() => byText('Save AI settings', box), 'Save AI settings');
    await wait(() => box.textContent.includes('Key saved · ending …4321'), 'key saved');
    check(!box.innerHTML.includes('sk-or-v1-e2e'), 'the key is saved and only its last 4 characters are shown');
    const model = await wait(() => [...box.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value.includes('gemma'))), 'model list');
    check(model.value === 'google/gemma-4-31b-it:free' && model.selectedOptions[0].textContent.includes('(recommended)') && ![...model.options].some((o) => o.value === 'openai/gpt-paid'), 'Gemma 4 31B is pre-selected and only free models are listed');
    await click(() => byText('Test', box), 'Test');
    await wait(() => /Working · answered by .* of 50 free requests used today/.test(box.textContent), 'test result');
    check(true, 'Test shows the answering model and the free requests used today');

    // 3. Ask MasalaPOS answers with figures used.
    const askSection = await openAsk();
    await askQuestion('How were sales this week?');
    const answer = await wait(() => askSection.querySelector('.ask-answer'), 'answer');
    check(answer.textContent.includes('fake answer') && [...answer.querySelectorAll('.ask-figures li')].some((li) => li.textContent.startsWith('Sales by day')), 'Ask MasalaPOS answers and lists "Sales by day" under Figures used');

    // 4. The free limit message.
    await askQuestion('Did we hit the limit?');
    await wait(() => askSection.querySelector('[role="alert"]')?.textContent.includes('free limit is used up'), 'limit message');
    check(true, 'a rate-limited question shows the free-limit message');

    // 5. Day-end summary and Copy.
    await click(() => byText('Day-end / GST'), 'Day-end tab');
    await click(() => byText('Write summary'), 'Write summary');
    const summary = await wait(() => document.querySelector('section[aria-label="AI day summary"]'), 'summary');
    await wait(() => summary.textContent.includes('Sales were steady'), 'summary text');
    await click(() => byText('Copy', summary), 'Copy');
    await wait(() => copied, 'copied');
    check(copied.includes('Sales were steady') && /^.+ · \d{4}-\d{2}-\d{2}\n/.test(copied), 'Write summary shows the day summary and Copy gives a WhatsApp-ready text');

    // 6. Dish editor: Write description fills the box and marks the form unsaved.
    await nav('catalog');
    await click(() => {
      const row = [...document.querySelectorAll('tr')].find((tr) => tr.textContent.includes('Paneer tikka'));
      return row && [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Edit' && !b.disabled);
    }, 'Edit Paneer tikka');
    const editor = await wait(() => document.querySelector('section[aria-label="Product editor"]'), 'product editor');
    const details = [...editor.querySelectorAll('details')].find((d) => d.textContent.startsWith('Description'));
    details.open = true; await pause(150);
    await click(() => byText('Write description', editor), 'Write description');
    const textarea = editor.querySelector('textarea');
    await wait(() => textarea.value.startsWith('Smoky paneer cubes'), 'description filled');
    check(editor.textContent.includes('Unsaved changes'), 'Write description fills the box and the dish is not saved until Save');

    // 7. Privacy: nothing about the customer reached the provider.
    const sent = JSON.stringify(await (await fetch(`${FAKE}/__qa/requests`)).json());
    check(sent.length > 100 && !sent.includes('Priya') && !sent.includes('98765'), 'no customer name or phone was sent to the provider');

    // 8. Offline.
    await fetch(`${FAKE}/__qa/offline`, { method: 'POST' });
    const again = await openAsk();
    await askQuestion('How were sales today?');
    await wait(() => again.querySelector('[role="alert"]')?.textContent.includes('needs internet'), 'offline message');
    check(true, 'with the provider unreachable, Ask shows the needs-internet message');

    window.__aiAssistantResult = { status: 'passed', passed: checks.length, checks };
  } catch (error) {
    window.__aiAssistantResult = { status: 'failed', error: String(error && error.message || error), checks };
  } finally {
    if (realClipboard) delete navigator.clipboard;
  }
  return window.__aiAssistantResult;
})();
