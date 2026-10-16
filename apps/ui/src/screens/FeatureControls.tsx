import type { User } from "../api";
import { useFeatures } from "../features";

export function FeatureControls({ user }: { user: User }) {
  const { catalog, ready, error, refresh } = useFeatures();
  return <section aria-label="Application features" className="feature-controls">
    <h2>Application features</h2><p>These modules are assigned to this restaurant by ForkFlow. Contact ForkFlow to change availability. Existing records are preserved.</p>
    {!ready && <p role="status">Loading features…</p>}
    {error && <div role="alert"><p>{error}</p><button onClick={refresh}>Retry feature load</button></div>}
    <ul className="marketplace-grid" aria-label="Feature catalog">{catalog?.features.filter(feature => !feature.integration).map(feature => <li className="panel marketplace-card" key={feature.id}>
      <div className="marketplace-card-head"><div><h3>{feature.name}</h3><span className="marketplace-tag">{feature.category}</span></div><span className="marketplace-pill">{!feature.configurable ? "Required" : feature.active ? "On" : feature.reason}</span></div>
      <p>{feature.description}</p>
      {feature.enabled && !feature.active && <p>Saved preference: on. {feature.reason}.</p>}
      <div className="marketplace-card-foot"><span>{feature.dependencies.length ? "Depends on " + feature.dependencies.map(id => catalog.features.find(item => item.id === id)?.name ?? id).join(", ") : ""}</span>
      <span>{feature.active ? "Available" : "Unavailable"}</span></div>
    </li>)}</ul>
  </section>;
}

