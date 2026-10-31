import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from "react";

// A small history router: every portal screen has its own URL under /portal, so a customer or an order can be opened in a new tab
// or shared. Paths here leave out the /portal prefix.
const BASE = "/portal";
const guards = new Set<() => boolean>();

export const currentPath = () => (window.location.pathname.startsWith(BASE) ? window.location.pathname.slice(BASE.length) : window.location.pathname) || "/";

/** Blocks navigation while it returns false (an unsaved form asks first). */
export function useLeaveGuard(guard: () => boolean) {
  useEffect(() => { guards.add(guard); return () => { guards.delete(guard); }; }, [guard]);
}

export function navigate(to: string, replace = false) {
  if (!replace && [...guards].some((guard) => !guard())) return;
  const url = `${BASE}${to}`;
  if (replace) window.history.replaceState(null, "", url); else window.history.pushState(null, "", url);
  window.dispatchEvent(new Event("portal:navigate"));
  if (!replace) window.scrollTo({ top: 0 });
}

/** The current path and query, re-rendering on every navigation. */
export function useLocation(): { path: string; search: URLSearchParams } {
  const read = () => ({ path: currentPath(), search: new URLSearchParams(window.location.search) });
  const [location, setLocation] = useState(read);
  useEffect(() => {
    const update = () => setLocation(read());
    window.addEventListener("popstate", update); window.addEventListener("portal:navigate", update);
    return () => { window.removeEventListener("popstate", update); window.removeEventListener("portal:navigate", update); };
  }, []);
  return location;
}

/** Matches "/customers/:id" against a path; returns the captured values, or null. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const names: string[] = [];
  const regex = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, name: string) => { names.push(name); return "([^/]+)"; })}/?$`);
  const found = path.match(regex);
  if (!found) return null;
  // A malformed escape (/customers/%E0%A4%A) is no match, not a crash of the whole page.
  try { return Object.fromEntries(names.map((name, i) => [name, decodeURIComponent(found[i + 1]!)])); } catch { return null; }
}

/** A real link (open in a new tab works) that navigates in place on a plain click. */
export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  return <a href={`${BASE}${to}`} {...rest} onClick={(event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); navigate(to);
  }} />;
}
