import "./kitchen-app.css";

export function DemoBanner({ demo, login = false }: { demo: boolean; login?: boolean }) {
  if (!demo) return null;
  return <aside className="demo-banner" aria-label="Demo environment"><strong>ForkFlow Demo</strong>
    <span>Sample data · Printing is simulated</span>
    {login ? <span>PINs: Admin 1234 · Cashier 2345 · Captain 3456 · Kitchen 4567</span>
      : <span>Reset: Demo menu on the main PC → Reset sample data</span>}
  </aside>;
}
