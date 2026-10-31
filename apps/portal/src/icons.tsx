// One outline icon set at 1.5px, drawn on a 16px grid, for the navigation and a few affordances.
const paths = {
  home: "M2.5 7 8 2.5 13.5 7v6.5h-4v-4h-3v4h-4z",
  leads: "M2 3h12l-4.5 5.5V13l-3-1.5v-3z",
  customers: "M6 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM1.5 13.5c.4-2.4 2.2-4 4.5-4s4.1 1.6 4.5 4M11 3a2.3 2.3 0 0 1 0 4.4M12.5 9.6c1.2.6 1.9 2 2 3.9",
  orders: "M3.5 1.5h9v13l-2-1.2-1.5 1.2-1.5-1.2-1.5 1.2-1.5-1.2-1 1.2zM6 5h4M6 8h4M6 11h2",
  renewals: "M13 5.5A5.5 5.5 0 0 0 3 4M3 1.5V4h2.5M3 10.5A5.5 5.5 0 0 0 13 12M13 14.5V12h-2.5",
  tickets: "M2 4.5h12v2a1.5 1.5 0 0 0 0 3v2H2v-2a1.5 1.5 0 0 0 0-3zM10 4.5v7",
  reports: "M2.5 13.5h11M4.5 11V7.5M8 11V3.5M11.5 11V6",
  users: "M8 7a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM3 14c.4-2.8 2.4-4.5 5-4.5s4.6 1.7 5 4.5",
  settings: "M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4",
  activity: "M2 8h3l2-5 2 10 2-5h3",
  key: "M10 6.5a3.5 3.5 0 1 0-3.4 2.7L2.5 13.3V15h2v-1.5H6V12h1.5l1.3-1.3",
  logout: "M6.5 2.5h-4v11h4M10.5 5l3 3-3 3M13.5 8h-7",
  search: "M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM14 14l-3.5-3.5",
  menu: "M2 4h12M2 8h12M2 12h12",
  invoices: "M4 1.5h6l2.5 2.5v10.5H4zM10 1.5V4h2.5M6 7.5h4M6 10h4M6 12.5h2",
  followups: "M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM8 4.5V8l2.5 1.5",
} as const;
export type IconName = keyof typeof paths;

export const Icon = ({ name }: { name: IconName }) =>
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;

/** The MasalaPOS mark: a fork in the MasalaPOS red, as on the POS app. */
export const Mark = () =>
  <svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#b92335" />
    <path d="M11 8v7a3 3 0 0 0 3 3v6M11 8v5M14 8v5M17 8v5M21 8c-1.7 0-3 2-3 5s1.3 4 3 4v7" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
