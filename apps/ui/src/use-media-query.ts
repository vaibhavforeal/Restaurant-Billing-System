import { useEffect, useState } from "react";

const match = (query: string) => typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false;

/** Whether a CSS media query matches now, following changes. False where `matchMedia` is missing. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => match(query));
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
}
