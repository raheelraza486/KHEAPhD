"use client";

import { useState } from "react";
import type { CoverageSummary } from "@/lib/coverage";
import worldMap from "@/lib/data/world-map.json";

const EMPTY_SUMMARY: CoverageSummary = {
  totalOperations: 0,
  totalSources: 0,
  representedLocations: 0,
  globalOperations: 0,
  unspecifiedOperations: 0,
  points: [],
  otherRegions: [],
};

type GlobalCoverageMapProps = {
  summary?: CoverageSummary;
  status: "loading" | "ready" | "error";
  onRetry: () => void;
};

export default function GlobalCoverageMap({ summary = EMPTY_SUMMARY, status, onRetry }: GlobalCoverageMapProps) {
  const [selectedName, setSelectedName] = useState("");
  const [zoom, setZoom] = useState(1);

  const representedMarkets = [...summary.points, ...summary.otherRegions]
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
  const marketsByName = new Map(representedMarkets.map((market) => [market.name, market]));
  const selected = marketsByName.get(selectedName);
  const selectedShape = worldMap.countries.find((country) => country.name === selected?.name);
  const viewWidth = worldMap.width / zoom;
  const viewHeight = worldMap.height / zoom;
  const viewX = Math.max(0, Math.min(worldMap.width - viewWidth, (selectedShape?.point[0] ?? 480) - viewWidth / 2));
  const viewY = Math.max(0, Math.min(worldMap.height - viewHeight, (selectedShape?.point[1] ?? 250) - viewHeight / 2));

  return (
    <section className="coverage-section" aria-labelledby="coverage-title">
      <div className="coverage-heading">
        <div>
          <h2 id="coverage-title">API coverage</h2>
          <p>Discover APIs across countries and regions.</p>
        </div>
        <div className="world-location-picker">
          <label className="sr-only" htmlFor="map-country-select">Find a country or region</label>
          <select id="map-country-select" value={selected?.name ?? ""} disabled={status !== "ready" || !representedMarkets.length} onChange={(event) => { setSelectedName(event.target.value); setZoom(1); }}>
            <option value="">{status === "loading" ? "Loading countries…" : "All countries / regions"}</option>
            {representedMarkets.map((market) => <option key={market.name} value={market.name}>{market.name}</option>)}
          </select>
          <a className="world-browse-link" href={selected ? `/apis?country=${encodeURIComponent(selected.name)}` : "/apis"}>Browse APIs <span aria-hidden="true">↗</span></a>
        </div>
      </div>

      <div className="world-explorer">
        <div className="world-map-stage">
          <div className="world-map-guidance">Select a highlighted country to explore</div>
          <svg className="world-map-canvas" viewBox={`${viewX} ${viewY} ${viewWidth} ${viewHeight}`} aria-label="World map of API catalogue locations" role="group">
            {worldMap.countries.map((country) => {
              const market = marketsByName.get(country.name);
              const isSelected = selected?.name === country.name;
              if (!market) return <path key={country.name} d={country.path} className="world-country" />;
              return <a key={country.name} href={`/apis?country=${encodeURIComponent(country.name)}`} aria-label={`${country.name}: Browse APIs.`} onMouseEnter={() => { if (zoom === 1) setSelectedName(country.name); }} onFocus={() => setSelectedName(country.name)} className={`world-country-link${isSelected ? " is-selected" : ""}`}>
                <title>{country.name} · Browse APIs</title>
                <path d={country.path} className="world-country has-apis" />
                {!country.path && <>
                  <circle cx={country.point[0]} cy={country.point[1]} r={12 / Math.sqrt(zoom)} className="world-country-hitarea" />
                  <circle cx={country.point[0]} cy={country.point[1]} r={4 / Math.sqrt(zoom)} className="world-country-marker" />
                </>}
              </a>;
            })}
          </svg>
          {(status !== "ready" || !representedMarkets.length) && <div className="world-map-loading" role={status === "error" ? "alert" : "status"}>{status === "loading" ? "Loading catalogue locations…" : status === "error" ? <><span>Locations could not be loaded.</span><button type="button" className="button secondary" onClick={onRetry}>Try again</button></> : "No catalogue locations recorded yet."}</div>}
          <div className="world-map-controls" aria-label="Map zoom">
              <button type="button" aria-label="Zoom out" disabled={zoom === 1} onClick={() => setZoom((value) => Math.max(1, value - 1))}>−</button>
              <button type="button" aria-label="Zoom in" disabled={zoom === 4 || status !== "ready" || !representedMarkets.length} onClick={() => setZoom((value) => Math.min(4, value + 1))}>+</button>
              <button type="button" aria-label="Reset world map" title="Reset world map" disabled={zoom === 1} onClick={() => setZoom(1)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" /></svg></button>
          </div>
        </div>
        <div className="world-map-footer">
          <div className="world-map-legend"><span className="world-legend-swatch" aria-hidden="true" />Listed in the catalogue</div>
          <nav className="world-coverage-links" aria-label="More catalogue locations">
            {summary.globalOperations > 0 && <a href="/apis?country=Global">Global APIs <span aria-hidden="true">↗</span></a>}
            {summary.unspecifiedOperations > 0 && <a href="/apis?country=Other%20%2F%20unspecified">Location not recorded <span aria-hidden="true">↗</span></a>}
          </nav>
        </div>
      </div>
      <div className="world-map-footnote"><p>Locations may be suggested from source information. Confirm service coverage in the API documentation.</p><a href="https://www.naturalearthdata.com/" target="_blank" rel="noreferrer">Map: Natural Earth</a></div>

    </section>
  );
}
