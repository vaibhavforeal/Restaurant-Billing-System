import "./kitchen-app.css";

export function DemoBanner({ demo, login = false }: { demo: boolean; login?: boolean }) {
  if (!demo) return null;
  return <aside className="demo-banner" aria-label="Demo environment"><strong>MasalaPOS Demo</strong>
    <span>Sample data · Printing is simulated</span>
    {login ? <span>Sign in as admin, cashier, captain or kitchen · password demo1234 · admin approval PIN 1234</span>
      : <span>Reset: Demo menu on the main PC → Reset sample data</span>}
  </aside>;
}
