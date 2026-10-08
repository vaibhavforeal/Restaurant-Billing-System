import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "./api";
import type { ReportPeriod, SalesReport } from "./sales-report";

export function useSalesReport(initialPeriod?: ReportPeriod) {
  const [period, setPeriod] = useState<ReportPeriod | null>(initialPeriod ?? null);
  const [report, setReport] = useState<SalesReport | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const revision = useRef(0);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  useEffect(() => {
    const request = ++revision.current;
    const controller = new AbortController();
    setReport(null); setError(""); setLoading(true);
    const query = period ? `?from=${encodeURIComponent(period.from)}&to=${encodeURIComponent(period.to)}` : "";
    void apiFetch<{ report: SalesReport }>(`/api/reports/sales${query}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) })
      .then(({ report: result }) => { if (request === revision.current) setReport(result); })
      .catch((e: unknown) => { if (!controller.signal.aborted && request === revision.current) setError(e instanceof Error ? e.message : "Could not load sales and collections"); })
      .finally(() => { if (request === revision.current) setLoading(false); });
    return () => { revision.current++; controller.abort(); };
  }, [period?.from, period?.to, version]);
  return { period, setPeriod, report, error, loading, refresh };
}
