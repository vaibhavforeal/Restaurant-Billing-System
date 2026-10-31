// Run on the fake licensing service's checkout page while licensing-server.mts is running (before licensing.js stops the service):
// navigate a browser tab to http://127.0.0.1:4129/subscribe?session=<fixtures.sessionToken> (the token is in browser-fixtures.js),
// then add this script. The fake service serves the Worker's real checkout markup and answers its POST with 401 session_expired.
(async () => {
  if (location.origin !== 'http://127.0.0.1:4129' || location.pathname !== '/subscribe') throw new Error('Open the fake service checkout page first.');
  const checks = [];
  const check = (ok, label) => { if (!ok) throw new Error(label); checks.push(label); };
  const wait = async (fn) => { const end = Date.now() + 5000; while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 30)); } throw new Error('Timed out: ' + document.body.innerText.slice(-1000)); };
  const visible = (el) => !!el && !el.hidden && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
  const expiredCopy = 'This payment link has expired. In MasalaPOS, open Settings > Plan and devices and press Subscribe again.';
  const form = document.getElementById('checkout'), expired = document.getElementById('expired');
  check(visible(form) && !visible(expired) && form.dataset.session.length === 43, 'A valid checkout page shows its form and no expired message');
  form.elements.email.value = 'owner@example.com'; form.querySelector('button').click();
  await wait(() => visible(expired));
  check(!visible(form) && visible(expired) && expired.textContent === expiredCopy && getComputedStyle(expired).display !== 'none', 'When the payment request answers 401 the form is hidden and the expired copy is shown');
  const stale = await fetch('/subscribe?session=expired'); const html = await stale.text();
  check(stale.status === 404 && html.includes(expiredCopy.replace('>', '&gt;')) && !html.includes('id="checkout"'), 'An unknown session link is a 404 page with the expired copy and no form');
  window.__licenseExpiredLinkChecks = { status: 'passed', checks };
  return window.__licenseExpiredLinkChecks;
})();
