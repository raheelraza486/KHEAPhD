"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { CoverageSummary } from "@/lib/coverage";
import ApiCategoryCells from "@/components/api-category-cells";
import GlobalCoverageMap from "@/components/global-coverage-map";
import worldMap from "@/lib/data/world-map.json";

export default function HomeDiscovery({ refreshKey = 0, contribution }: { refreshKey?: number; contribution: ReactNode }) {
  const [summary, setSummary] = useState<CoverageSummary>();
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [coverageOpen, setCoverageOpen] = useState(false);

  const loadCoverage = useCallback(async (bypassCache = false, signal?: AbortSignal) => {
    setStatus("loading");
    try {
      const response = await fetch(`/api/apis?view=coverage${bypassCache ? `&refresh=${Date.now()}` : ""}`, {
        cache: bypassCache ? "no-store" : "default", signal,
      });
      if (!response.ok) throw new Error("Coverage request failed");
      setSummary(await response.json() as CoverageSummary);
      setStatus("ready");
    } catch (error) {
      if (signal?.aborted || error instanceof DOMException && error.name === "AbortError") return;
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadCoverage(refreshKey > 0, controller.signal);
    return () => controller.abort();
  }, [loadCoverage, refreshKey]);

  const retry = () => { void loadCoverage(true); };
  const represented = new Set([...(summary?.points ?? []), ...(summary?.otherRegions ?? [])].map((location) => location.name));
  return <>
    <ApiCategoryCells />
    <div className="home-secondary">
      <button className="home-coverage-toggle" type="button" aria-expanded={coverageOpen} aria-controls="home-coverage-panel" onClick={() => setCoverageOpen((open) => !open)}>
        <svg className="home-coverage-thumbnail" viewBox="0 0 960 500" aria-hidden="true">
          {worldMap.countries.filter((country) => country.path).map((country) => <path key={country.name} d={country.path} className={represented.has(country.name) ? "is-covered" : undefined} />)}
        </svg>
        <span><strong>Country coverage</strong><small>Explore by location</small></span>
        <span className="home-coverage-state">{coverageOpen ? "Expanded" : "Collapsed"}</span>
        <svg className="home-disclosure-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      <div className="home-contribution-bar">
        <div className="home-contribution-copy">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M14 3H5v18h14V8zM14 3v5h5M12 12v6m-3-3h6" /></svg>
          <span><strong>Submit an API</strong><small>Add from an OpenAPI link</small></span>
        </div>
        {contribution}
      </div>
    </div>
    <div id="home-coverage-panel" hidden={!coverageOpen}>
      {coverageOpen && <GlobalCoverageMap summary={summary} status={status} onRetry={retry} />}
    </div>
  </>;
}
