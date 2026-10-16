import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const harness = vi.hoisted(() => ({ active: false, mounted: { current: false } }));
vi.mock("react", async importOriginal => ({ ...await importOriginal<typeof import("react")>(), useRef: () => harness.mounted, useSyncExternalStore: () => ({ catalog: null, ready: true, error: "" }) }));
vi.mock("./features-store", () => ({ FeaturesStore: class {} }));
vi.mock("./api", () => ({ apiFetch: vi.fn(), session: { clear: vi.fn() } }));
vi.mock("./ws", () => ({ connectWs: vi.fn() }));

import { FeatureWorkspace } from "./features";
import * as React from "react";

function render(active: boolean) {
  harness.active = active;
  vi.spyOn(React, "useContext").mockReturnValue({ isActive: () => harness.active });
  return renderToStaticMarkup(React.createElement(FeatureWorkspace, { id: "takeaway", children: React.createElement("span", null, "Order workspace") }));
}

describe("feature workspace lifecycle", () => {
  beforeEach(() => { vi.restoreAllMocks(); harness.mounted.current = false; });
  it("does not mount a subsystem before its feature becomes active", () => {
    expect(render(false)).not.toContain("Order workspace");
  });
  it("mounts when availability is loaded", () => {
    expect(render(true)).toContain("Order workspace");
  });
  it("retains a mounted workspace and hides interaction when disabled", () => {
    render(true);
    const disabled = render(false);
    expect(disabled).toContain("Order workspace");
    expect(disabled).toContain('hidden=""');
    expect(disabled).toContain('inert=""');
    expect(render(true)).not.toContain('hidden=""');
  });
});

