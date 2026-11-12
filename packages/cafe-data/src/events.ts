/** Screens re-read their data when any write reports a change. */
const listeners = new Set<() => void>();

export function onDataChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function dataChanged(): void {
  for (const fn of [...listeners]) fn();
}
