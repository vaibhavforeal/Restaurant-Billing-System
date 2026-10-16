export interface OutletIdentity { outletIdentity: string; generation: string }
export interface OutletBinding extends OutletIdentity { version: 1; prefix: string; archiveKey: string | null }
export interface BrowserStorage { readonly length: number; key(index: number): string | null; getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void; clear(): void }
export const OUTLET_BINDING_KEY = "forkflow.outlet-binding.v1";
const SCOPE_PREFIX = "forkflow.outlet-scope.v1.";
const ARCHIVE_PREFIX = "forkflow.outlet-archive.v1.";
let activeBinding: OutletBinding | null = null;
function keys(source: BrowserStorage): string[] { const result: string[] = []; for (let i = 0; i < source.length; i++) { const key = source.key(i); if (key !== null) result.push(key); } return result; }
function readBinding(source: BrowserStorage): OutletBinding | null {
  const raw = source.getItem(OUTLET_BINDING_KEY);
  if (raw === null) return null;
  try { const result = JSON.parse(raw) as OutletBinding; if (result.version !== 1 || typeof result.outletIdentity !== "string" || typeof result.generation !== "string" || typeof result.prefix !== "string" || !result.prefix.startsWith(SCOPE_PREFIX)) throw new Error(); return result; }
  catch { throw new Error("The saved outlet identity cannot be read. Preserve browser data and contact support before continuing."); }
}
export function verifyOutletHealth(health: unknown, source: BrowserStorage): OutletIdentity | null {
  if (!health || typeof health !== "object") throw new Error("The outlet returned an invalid health response.");
  const value = health as Partial<OutletIdentity>;
  if (value.outletIdentity === undefined) {
    // Compatibility for pre-identity servers and existing isolated test fixtures.
    // Never downgrade a browser which has already connected to an identified outlet.
    if (readBinding(source)) throw new Error("The outlet identity is missing. Reconnect to the original outlet or contact support.");
    return null;
  }
  if (typeof value.outletIdentity !== "string" || !value.outletIdentity.trim() || /[\r\n]/.test(value.outletIdentity)) throw new Error("The outlet identity is invalid.");
  if (typeof value.generation !== "string" || !value.generation.trim() || /[\r\n]/.test(value.generation)) throw new Error("The outlet recovery generation is missing or invalid.");
  return { outletIdentity: value.outletIdentity, generation: value.generation };
}
/** Archive before changing the binding. Old physical keys remain inert for manual recovery. */
export function bindOutletStorage(source: BrowserStorage, identity: OutletIdentity): OutletBinding {
  const previous = readBinding(source);
  if (previous?.outletIdentity === identity.outletIdentity && previous.generation === identity.generation) return previous;
  const saved: Record<string, string> = {};
  for (const key of keys(source)) {
    const previousScope = previous ? key.startsWith(previous.prefix) : key.startsWith("forkflow.") && !key.startsWith(SCOPE_PREFIX) && !key.startsWith(ARCHIVE_PREFIX) && key !== OUTLET_BINDING_KEY;
    if (previousScope) { const value = source.getItem(key); if (value !== null) saved[key] = value; }
  }
  const nonce = crypto.randomUUID();
  let archiveKey: string | null = null;
  if (Object.keys(saved).length) {
    archiveKey = `${ARCHIVE_PREFIX}${Date.now()}.${nonce}`;
    const archive = JSON.stringify({ version: 1, previous, next: identity, savedAt: Date.now(), entries: saved });
    source.setItem(archiveKey, archive);
    if (source.getItem(archiveKey) !== archive) throw new Error("Browser recovery archive could not be verified. No outlet data was switched.");
  }
  const binding: OutletBinding = { ...identity, version: 1, prefix: `${SCOPE_PREFIX}${encodeURIComponent(identity.outletIdentity)}.${encodeURIComponent(identity.generation)}.${nonce}.`, archiveKey };
  const serialized = JSON.stringify(binding);
  source.setItem(OUTLET_BINDING_KEY, serialized);
  if (source.getItem(OUTLET_BINDING_KEY) !== serialized) throw new Error("Browser outlet identity could not be saved. Free storage and retry.");
  return binding;
}
export function scopedStorage(source: BrowserStorage, binding: OutletBinding): BrowserStorage {
  const scopeKeys = () => keys(source).filter(key => key.startsWith(binding.prefix));
  const current = () => { if (readBinding(source)?.prefix !== binding.prefix) throw new Error("The outlet identity changed in another window. Reopen ForkFlow before continuing."); };
  return {
    get length() { return scopeKeys().length; },
    key(index) { const key = scopeKeys()[index]; return key === undefined ? null : key.slice(binding.prefix.length); },
    getItem(key) { return source.getItem(binding.prefix + key); },
    setItem(key, value) { current(); source.setItem(binding.prefix + key, value); },
    removeItem(key) { current(); source.removeItem(binding.prefix + key); },
    clear() { current(); for (const key of scopeKeys()) source.removeItem(key); },
  };
}
export function activateOutletIdentity(health: unknown): OutletBinding | null {
  const identity = verifyOutletHealth(health, localStorage);
  activeBinding = identity ? bindOutletStorage(localStorage, identity) : null;
  return activeBinding;
}
export function outletIdentityHeaders(): Record<string, string> {
  if (!activeBinding) return {};
  if (readBinding(localStorage)?.prefix !== activeBinding.prefix) throw new Error("The outlet identity changed. Reopen ForkFlow before continuing.");
  return { "x-forkflow-outlet-identity": activeBinding.outletIdentity, "x-forkflow-generation": activeBinding.generation };
}
function currentStorage(): BrowserStorage { return activeBinding ? scopedStorage(localStorage, activeBinding) : localStorage; }
/** Dynamic facade preserves legacy fixture keys until verified boot binds an outlet. */
export const outletStorage: BrowserStorage = {
  get length() { return currentStorage().length; }, key: index => currentStorage().key(index),
  getItem: key => currentStorage().getItem(key), setItem: (key, value) => currentStorage().setItem(key, value),
  removeItem: key => currentStorage().removeItem(key), clear: () => currentStorage().clear(),
};
