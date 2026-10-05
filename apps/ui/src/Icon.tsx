import type { CSSProperties } from "react";

const paths = {
  home: "M3 10 12 3l9 7M5 9v12h5v-7h4v7h5V9",
  tables: "M3 7h18v4H3zM6 11 4 21m14-10 2 10M7 16h10",
  bills: "M6 3h12v18l-3-2-3 2-3-2-3 2V3Zm3 5h6m-6 4h6",
  reports: "M4 20h17M7 16v-5m5 5V5m5 11V9",
  inventory: "m3 7 9-4 9 4v10l-9 4-9-4V7Zm0 0 9 4 9-4m-9 4v10M7.5 5 17 9",
  kitchen: "M7 16v5h10v-5M7 16h10V11a4 4 0 0 0 1-8 4 4 0 0 0-3 1 4 4 0 0 0-6 0 4 4 0 1 0-2 7v5Z",
  catalog: "M4 3v5a3 3 0 0 0 6 0V3M7 3v18M18 3c-3 3-3 8 0 8h2M20 3v18",
  users: "M15 21v-3a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v3M9 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm8-7a3.5 3.5 0 0 1 0 7m1 4a4 4 0 0 1 3 4v3",
  settings: "m9 3-1 3-3 1-2 3 2 2-1 3 2 3 3-1 3 2 3-2 3 1 2-3-1-3 2-2-2-3-3-1-1-3H9Zm3 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
  logout: "M9 4H4v16h5m5-13 5 5-5 5M9 12h11",
  arrow: "M5 12h14m-6-6 6 6-6 6",
  plus: "M12 5v14M5 12h14",
  search: "M21 21l-5-5m-6 2a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z",
  bag: "M5 7h14l1 14H4L5 7Zm4 0V5a3 3 0 0 1 6 0v2",
  clock: "M12 6v6l4 2m-4 8a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z",
  check: "m5 12 4 4L19 6",
} as const;
export type IconName = keyof typeof paths;
export function Icon({ name, size = 20, style }: { name: IconName; size?: number; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}><path d={paths[name]} /></svg>;
}
export function Brand() {
  return <div className="brand"><span className="brand-mark"><Icon name="catalog" size={22} /></span><span>ForkFlow</span></div>;
}
