import "./kitchen-app.css";

export function DemoBanner({ demo, sampleData = false, login = false }: { demo: boolean; sampleData?: boolean; login?: boolean }) {
  if (!demo && !sampleData) return null;
  return <aside className="demo-banner" aria-label="Sample environment"><strong>{sampleData ? "MasalaPOS Dev Sample Data" : "MasalaPOS Demo"}</strong>
    <span>Sample data · Printing is simulated</span>
    {login ? <span>Sign in as admin, cashier, captain or kitchen · password demo1234 · admin approval PIN 1234</span>
      : <span>{sampleData ? "Sample Data" : "Demo"} menu → Reset sample data</span>}
  </aside>;
}
