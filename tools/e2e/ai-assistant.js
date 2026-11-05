// AI assistant gate, end to end through the licensing service's relay. Start `node --import tsx tools/e2e/fake-openrouter.mts`, then
// `node --import tsx tools/e2e/ai-assistant-server.mts` (both fresh each run), open http://127.0.0.1:4160/, sign in as admin / admin-password,
// then add this file to the page. Result: window.__aiAssistantResult. Drives Settings, Reports → Ask MasalaPOS, Day-end and the dish editor.
(async () => {
  if (location.origin !== 'http://127.0.0.1:4160') throw new Error('Disposable http://127.0.0.1:4160 only');
  const FAKE = 'http://127.0.0.1:4161', QA = 'http://127.0.0.1:4163';
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
  const openSettings = async () => {
    await nav('settings');
    await click(() => buttons().find((b) => b.textContent.trim().startsWith('Restaurant profile')), 'Restaurant profile');
    return (await wait(() => [...document.querySelectorAll('legend')].find((l) => l.textContent.startsWith('AI assistant')), 'AI assistant settings')).closest('fieldset');
  };
  const moreReports = () => document.querySelector('select[aria-label="More reports"]');
  /** Reports → the "Ask AI" tab on the right edge, which slides Ask MasalaPOS in as a side panel over the current report. */
  const openAsk = async () => {
    await nav('Reports & Analytics');
    const tab = await wait(() => document.querySelector('button.ask-side-tab'), 'Ask AI side tab');
    if (tab.getAttribute('aria-expanded') !== 'true') { tab.click(); await pause(250); }
    return wait(() => document.querySelector('aside.ask-panel:not([hidden]) section[aria-label="Ask MasalaPOS"]'), 'Ask MasalaPOS side panel');
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
    // 1. MasalaPOS hasn't switched it on yet: Settings says so (no key field), and Ask points the admin there.
    let box = await openSettings();
    await wait(() => box.textContent.includes('Not switched on for this restaurant. Contact MasalaPOS'), 'not switched on');
    check(box.textContent.includes('provided by MasalaPOS') && !box.querySelector('input[type="password"]') && !box.querySelector('select'), 'Settings shows "not switched on" with no key or model fields');
    const before = await openAsk();
    check(/isn't on for this restaurant yet/.test(before.textContent) && !before.querySelector('input[aria-label="Your question"]'), 'Ask MasalaPOS points the admin to Settings while it is off');
    check(![...moreReports().options].some((o) => o.value === 'ask') && document.querySelector('section.sales-reports .report-tabs button[aria-pressed="true"]'),
      'Ask is a side panel over the open report, no longer in "More reports"');
    const closeButton = document.querySelector('aside.ask-panel button[aria-label="Close Ask MasalaPOS"]');
    closeButton.click(); await pause(250);
    check(document.querySelector('aside.ask-panel').hidden && document.querySelector('button.ask-side-tab').getAttribute('aria-expanded') === 'false', 'the side panel closes');

    // 2. MasalaPOS switches it on (the portal's switch); Check picks it up.
    await fetch(`${QA}/__qa/ai?enabled=1&limit=40`, { method: 'POST' });
    box = await openSettings();
    await click(() => byText('Check', box), 'Check');
    await wait(() => box.textContent.includes('On for this restaurant · 0 of 40 requests used today'), 'switched on');
    check(true, 'after MasalaPOS switches it on, Check shows "On for this restaurant · 0 of 40 requests used today"');

    // 3. Ask MasalaPOS: real bold and list elements, figures as chips.
    const askSection = await openAsk();
    await askQuestion('How were sales this week?');
    const answer = await wait(() => askSection.querySelector('.ask-answer'), 'answer');
    const card = answer.querySelector('.ai-card');
    check(answer.querySelector('.ask-question')?.textContent.includes('How were sales this week?') && card?.textContent.includes('MasalaPOS AI'), 'the question shows as "You asked" and the answer in a MasalaPOS AI card');
    check(card.querySelector('strong')?.textContent === 'steady' && card.querySelectorAll('li').length === 2 && card.querySelector('em') && !card.textContent.includes('**'), 'the answer renders bold, a bullet list and italics, with no raw ** showing');
    check([...card.querySelectorAll('.ai-figure')].some((chip) => chip.textContent.startsWith('Sales by day')) && card.querySelector('.ai-model'), '"Sales by day" shows as a figures chip, with the model tag');

    // 4. The provider's rate limit has a plain message.
    await askQuestion('Is the service busy?');
    await wait(() => askSection.querySelector('[role="alert"]')?.textContent.includes('The AI service is busy right now'), 'busy message');
    check(true, 'the provider rate limit shows "The AI service is busy right now"');

    // 4b. A slow model (20 s, past the app's usual 15 s request timeout) still answers.
    await askQuestion('A slow question about sales?');
    await wait(() => [...askSection.querySelectorAll('.ask-answer')].some((a) => a.textContent.includes('slow but complete answer')), 'slow answer', 45000);
    check(!askSection.querySelector('[role="alert"]')?.textContent.includes('needs internet'), 'a reply taking 20 s still arrives instead of a false "needs internet"');

    // 5. Day-end summary and Copy.
    await click(() => byText('Day-end / GST'), 'Day-end tab');
    await click(() => byText('Write summary'), 'Write summary');
    const summary = await wait(() => document.querySelector('section[aria-label="AI day summary"]'), 'summary');
    await wait(() => summary.textContent.includes('Sales were steady'), 'summary text');
    check(summary.querySelectorAll('li').length === 2 && summary.querySelector('strong'), 'the day summary renders as a bullet list in the AI card');
    await click(() => byText('Copy', summary), 'Copy');
    await wait(() => copied, 'copied');
    check(copied.includes('• Sales were *steady*') && /^.+ · \d{4}-\d{2}-\d{2}\n/.test(copied), 'Copy gives WhatsApp-ready text (*bold*, • bullets)');

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

    // 7. What reached the provider: MasalaPOS's key (never one from the restaurant), and nothing about the customer.
    const { requests } = await (await fetch(`${FAKE}/__qa/requests`)).json();
    check(requests.length > 3 && requests.every((r) => r.authorization === 'Bearer sk-or-v1-vendor-e2e'), "every provider request carried MasalaPOS's key from the service");
    const sent = JSON.stringify(requests);
    check(!sent.includes('Priya') && !sent.includes('98765'), 'no customer name or phone was sent to the provider');

    // 8. The daily limit, counted by the service.
    box = await openSettings();
    await click(() => byText('Check', box), 'Check');
    const shown = await wait(() => /On for this restaurant · \d+ of 40/.test(box.textContent) && box.textContent, 'usage');
    const used = Number(/On for this restaurant · (\d+) of 40/.exec(shown)[1]);
    check(used >= 4, `the service counted today's AI requests (${used} of 40)`);
    await fetch(`${QA}/__qa/ai?enabled=1&limit=${used}`, { method: 'POST' });
    const limited = await openAsk();
    await askQuestion('How were sales today?');
    await wait(() => limited.querySelector('[role="alert"]')?.textContent.includes("Today's AI limit for this restaurant is used up"), 'daily limit message');
    check(true, "at the restaurant's daily limit, Ask says today's AI limit is used up");

    // 9. The service unreachable: needs internet.
    await fetch(`${QA}/__qa/service-offline`, { method: 'POST' });
    const again = await openAsk();
    await askQuestion('How were sales today?');
    await wait(() => again.querySelector('[role="alert"]')?.textContent.includes('needs internet'), 'offline message');
    check(true, 'with the MasalaPOS service unreachable, Ask shows the needs-internet message');

    window.__aiAssistantResult = { status: 'passed', passed: checks.length, checks };
  } catch (error) {
    window.__aiAssistantResult = { status: 'failed', error: String(error && error.message || error), checks };
  } finally {
    if (realClipboard) delete navigator.clipboard;
  }
  return window.__aiAssistantResult;
})();
