// Run with agent-browser eval --stdin against the disposable takeaway-preview server.
(async () => {
  if (location.origin !== 'http://127.0.0.1:4121') throw new Error('Use the isolated QA server');
  const checks = [];
  const check = (value, name) => { if (!value) throw new Error(name); checks.push(name); };
  const pause = (ms = 80) => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async (fn, name) => { for (let i = 0; i < 100; i++) { if (fn()) return; await pause(); } throw new Error(name); };
  const click = async (text, root = document) => {
    const button = [...root.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.disabled);
    if (!button) throw new Error('Missing button: ' + text);
    button.click(); await pause();
  };
  const headers = { authorization: 'Bearer ' + localStorage.getItem('forkflow.token'), 'x-forkflow-device': localStorage.getItem('forkflow.device.v1'), 'content-type': 'application/json' };
  const api = async (path, method = 'GET', body, extra = {}) => {
    const res = await fetch('/api' + path, { method, headers: { ...headers, ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await res.json(); if (!res.ok) throw new Error(path + ': ' + JSON.stringify(data)); return data;
  };
  const nativeNotification = window.Notification;
  const nativeFocus = document.hasFocus;
  const nativeOscillator = AudioContext.prototype.createOscillator;
  const notifications = [];
  let tones = 0;
  window.__qrNotificationQA = { checks, notifications, status: 'running' };
  window.Notification = class {
    static permission = 'granted';
    constructor(title, options) { this.title = title; this.options = options; notifications.push(this); }
    close() { this.closed = true; }
  };
  document.hasFocus = () => false;
  AudioContext.prototype.createOscillator = function() { tones++; return nativeOscillator.call(this); };
  try {
    await click('Review requests');
    await wait(() => document.querySelector('dialog[open]'), 'QR dialog opens');
    check(document.querySelector('.qr-notification-controls input').checked, 'QR sound enabled by default');
    await click('Test sound');
    check(tones === 2, 'Test sound produces the two-note chime');
    await click('Close', document.querySelector('dialog[open]'));
    await click('home');
    tones = 0;
    const { tables } = await api('/tables');
    const { products } = await api('/products');
    const product = products.find(p => p.name === 'Masala chai');
    const qr = (await api('/qr/tables/' + tables[0].id, 'PUT', { enabled: true })).table;
    const extra = { 'x-qr-token': qr.path.split('#')[1] };
    const menu = await api('/guest/menu', 'GET', null, extra);
    const submit = async () => (await api('/guest/requests', 'POST', {
      clientRef: crypto.randomUUID(), receiptToken: [...crypto.getRandomValues(new Uint8Array(32))].map(n => n.toString(16).padStart(2, '0')).join(''),
      menuVersion: menu.menuVersion, items: [{ productId: product.id, variantId: null, qty: 1, note: '' }],
    }, extra)).request;
    const first = await submit();
    await wait(() => document.querySelector('.qr-notification-banner')?.textContent.includes('1 QR order waiting'), 'Live alert appears on Home');
    check(document.querySelector('h2').textContent === 'Dashboard', 'New request does not interrupt the current screen');
    check(tones === 2 && notifications.length === 1, 'One chime and one background desktop notification per arrival');
    check(notifications[0].options.body.includes(tables[0].name), 'Desktop alert identifies the table');
    window.dispatchEvent(new Event('focus')); await pause(400);
    check(tones === 2 && notifications.length === 1, 'Focus refresh does not repeat notifications');
    await click('Review QR orders');
    await wait(() => document.querySelector('dialog[open]')?.textContent.includes('Accept & open order'), 'Global review opens the pending inbox');
    check(document.querySelector('dialog[open]').textContent.includes(tables[0].name), 'Review opens the actual submitted request');
    document.querySelector('.qr-notification-controls input').click(); await pause();
    check(localStorage.getItem('forkflow.qr-sound.v1') === 'off', 'Mute preference is saved on this device');
    await click('Close', document.querySelector('dialog[open]'));
    const second = await submit();
    await wait(() => document.querySelector('.qr-notification-banner')?.textContent.includes('2 QR orders waiting'), 'Second request arrives');
    check(tones === 2 && notifications.length === 2, 'Mute silences audio but retains visual and desktop alerts');
    await api('/qr/requests/' + first.id + '/reject', 'POST', { reason: 'QA complete' });
    await api('/qr/requests/' + second.id + '/reject', 'POST', { reason: 'QA complete' });
    await wait(() => !document.querySelector('.qr-notification-banner'), 'Alert clears after requests are reviewed');
    check(tones === 2 && notifications.length === 2, 'Review changes do not announce new orders');
    await click('Review requests');
    document.querySelector('.qr-notification-controls input').click();
    await click('Close', document.querySelector('dialog[open]'));
    await submit();
    await wait(() => document.querySelector('.qr-notification-banner'), 'Final layout request arrives');
    window.__qrNotificationQA.status = 'passed';
    return { status: 'passed', checks, tones, desktopNotifications: notifications.length };
  } finally {
    window.Notification = nativeNotification; document.hasFocus = nativeFocus;
    AudioContext.prototype.createOscillator = nativeOscillator;
  }
})();
