import { Component, type ErrorInfo, type ReactNode } from "react";

/** Catches a crash while drawing or loading a screen so staff see a way back instead of a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override componentDidCatch(error: Error, info: ErrorInfo) { console.error("MasalaPOS screen crashed", error, info.componentStack); }
  override render() {
    if (!this.state.failed) return this.props.children;
    return <div role="alert" style={{ padding: "2rem", textAlign: "center" }}>
      <h2>Something went wrong</h2>
      <p>This screen hit an unexpected problem. Anything already saved is safe.</p>
      <button className="primary" onClick={() => window.location.reload()}>Reload</button>
    </div>;
  }
}
