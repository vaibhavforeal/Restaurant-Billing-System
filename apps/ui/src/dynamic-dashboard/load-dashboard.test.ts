import { describe, expect, it } from "vitest";
import { DashboardLoadFailed, loadDashboard } from "./load-dashboard";

describe("lazy dashboard loading", () => {
  it("passes the dashboard component through when the chunk loads", async () => {
    const Dashboard = () => null;
    const loaded = await loadDashboard(async () => ({ DynamicDashboard: Dashboard }));
    expect(loaded.default).toBe(Dashboard);
  });

  it("resolves to a fallback instead of throwing when the chunk cannot be fetched", async () => {
    const loaded = await loadDashboard(() => Promise.reject(new TypeError("Failed to fetch dynamically imported module")));
    expect(loaded.default).toBe(DashboardLoadFailed);
  });
});
