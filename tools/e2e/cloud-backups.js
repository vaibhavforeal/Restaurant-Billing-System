// Disposable backups-server fixture, signed in as admin.
(async () => {
  if (location.origin !== "http://127.0.0.1:4169") throw new Error("Disposable backup fixture required");
  const checks = [];
  const check = (ok, message) => { if (!ok) throw new Error(message); checks.push(message); };
  const wait = async (fn, message) => {
    const end = Date.now() + 8000;
    while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error(`Timed out: ${message}`);
  };
  const button = text => [...document.querySelectorAll("button")].find(b => b.textContent.trim() === text);
  const api = async (path, method = "GET", body) => {
    const response = await fetch(path, { method, headers: {
      authorization: `Bearer ${localStorage.getItem("forkflow.token")}`,
      "x-forkflow-device": localStorage.getItem("forkflow.device.v1"), "content-type": "application/json",
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, ...await response.json() };
  };
  button("settings").click();
  const details = await wait(() => [...document.querySelectorAll("details")].find(d => d.querySelector("summary")?.textContent === "Backups & connections"), "backup section");
  if (!details.open) details.querySelector("summary").click();
  await wait(() => button("Save cloud preferences"), "cloud settings loaded");
  check(document.querySelector(".cloud-backup-state").textContent === "Not configured", "Cloud state reports not configured");
  check(button("Connect Google Drive").disabled && button("Back up to Drive now").disabled && button("Retry uploads").disabled, "Unconfigured cloud actions are disabled");
  check(document.querySelector(".cloud-backup-facts").textContent.includes("No uploads yet"), "No invented successful cloud upload");
  const root = document.querySelector(".cloud-backups");
  const folder = root.querySelector('input[maxlength="100"]');
  const days = root.querySelector('input[type="number"]');
  const set = (input, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); };
  set(folder, "Cafe Cloud Backups"); set(days, "45");
  root.querySelector('input[type="checkbox"]').click();
  await wait(() => !button("Save cloud preferences").disabled, "save enabled");
  button("Save cloud preferences").click();
  await wait(() => root.textContent.includes("Cloud backup preferences saved."), "preferences saved");
  check((await api("/api/system/cloud-backups")).folderName === "Cafe Cloud Backups", "Cloud preferences persist through API");
  const before = (await api("/api/system/backups")).backups.length;
  button("Back up now").click();
  await wait(() => document.querySelector(".system-settings").textContent.includes("Verified local backup saved."), "manual local backup");
  check((await api("/api/system/backups")).backups.length === before + 1, "Local backup works with cloud unavailable");
  for (const action of ["upload", "retry", "disconnect"]) {
    const response = await api(`/api/system/cloud-backups/${action}`, "POST");
    check(response.status === 409 && response.error.includes("not configured"), `${action} cannot bypass unconfigured state`);
  }
  set(days, "1"); await wait(() => button("Save cloud preferences").disabled, "invalid retention disabled");
  check(true, "Invalid retention cannot be saved from UI"); set(days, "45");
  button("home").click();
  await wait(() => button("settings") && !button("settings").disabled, "home loaded");
  button("settings").click();
  const reopened = await wait(() => [...document.querySelectorAll("details")].find(d => d.querySelector("summary")?.textContent === "Backups & connections"), "reopened settings");
  if (!reopened.open) reopened.querySelector("summary").click();
  await wait(() => document.querySelector('.cloud-backups input[maxlength="100"]')?.value === "Cafe Cloud Backups", "preferences reloaded");
  check(document.querySelector('.cloud-backups input[type="number"]').value === "45" && !document.querySelector('.cloud-backups input[type="checkbox"]').checked, "Saved preferences survive remount");
  window.__cloudBackupResult = { status: "passed", checks }; return window.__cloudBackupResult;
})();
