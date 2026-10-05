const field = document.getElementById('address'), submit = document.getElementById('submit'), error = document.getElementById('error');
error.textContent = new URLSearchParams(location.search).get('error') || '';
window.kitchenConnection.savedAddress().then(address => { field.value = address; field.focus(); }).catch(() => { error.textContent = 'Could not load the saved connection.'; });
document.getElementById('connection').addEventListener('submit', async event => {
  event.preventDefault(); if (submit.disabled) return;
  submit.disabled = true; field.disabled = true; submit.textContent = 'Connecting…'; error.textContent = '';
  try { const result = await window.kitchenConnection.connect(field.value); if (!result.ok) error.textContent = result.error; }
  catch { error.textContent = 'Could not connect. Check the address and try again.'; }
  finally { submit.disabled = false; field.disabled = false; submit.textContent = 'Connect to POS'; }
});
