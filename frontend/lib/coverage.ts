import {
  UNSPECIFIED_COUNTRY_REGION,
  countryRegionForRecord,
  type CountryRegionSource,
} from "./country-region.ts";

export type CoverageSource = CountryRegionSource & {
  is_active?: boolean;
};

export type CoveragePoint = {
  name: string;
  operations: number;
  sources: number;
  latitude: number;
  longitude: number;
};

export type CoverageSummary = {
  totalOperations: number;
  totalSources: number;
  representedLocations: number;
  globalOperations: number;
  unspecifiedOperations: number;
  points: CoveragePoint[];
  otherRegions: Array<{ name: string; operations: number; sources: number }>;
};

type CoverageLocation = Omit<CoveragePoint, "operations" | "sources"> & {
  aliases?: readonly string[];
};

// Coordinates are country/region label points, not provider addresses. They are
// deliberately kept in this small local table so the homepage needs no map SDK,
// tracking script, or third-party request.
const COVERAGE_LOCATIONS: readonly CoverageLocation[] = [
  { name: "Australia", latitude: -25.3, longitude: 133.8 },
  { name: "Austria", latitude: 47.5, longitude: 14.6 },
  { name: "Belgium", latitude: 50.5, longitude: 4.5 },
  { name: "Brazil", latitude: -10.8, longitude: -52.9 },
  { name: "Bulgaria", latitude: 42.7, longitude: 25.5 },
  { name: "Canada", latitude: 56.1, longitude: -106.3 },
  { name: "China", latitude: 35.9, longitude: 104.2 },
  { name: "Colombia", latitude: 4.6, longitude: -74.3 },
  { name: "Croatia", latitude: 45.1, longitude: 15.2 },
  { name: "Czech Republic", latitude: 49.8, longitude: 15.5, aliases: ["Czechia"] },
  { name: "Denmark", latitude: 56.3, longitude: 9.5 },
  { name: "Estonia", latitude: 58.6, longitude: 25.0 },
  { name: "European Union", latitude: 50.9, longitude: 10.5, aliases: ["EU"] },
  { name: "Finland", latitude: 61.9, longitude: 25.7 },
  { name: "France", latitude: 46.2, longitude: 2.2 },
  { name: "Germany", latitude: 51.2, longitude: 10.5 },
  { name: "Greece", latitude: 39.1, longitude: 21.8 },
  { name: "Hong Kong", latitude: 22.3, longitude: 114.2 },
  { name: "Hungary", latitude: 47.2, longitude: 19.5 },
  { name: "India", latitude: 20.6, longitude: 79.0 },
  { name: "Indonesia", latitude: -2.5, longitude: 118.0 },
  { name: "Ireland", latitude: 53.1, longitude: -8.2 },
  { name: "Israel", latitude: 31.0, longitude: 34.9 },
  { name: "Italy", latitude: 42.8, longitude: 12.6 },
  { name: "Japan", latitude: 36.2, longitude: 138.3 },
  { name: "Malaysia", latitude: 4.2, longitude: 101.9 },
  { name: "Mexico", latitude: 23.6, longitude: -102.6 },
  { name: "Netherlands", latitude: 52.1, longitude: 5.3 },
  { name: "New Zealand", latitude: -40.9, longitude: 174.9 },
  { name: "Norway", latitude: 60.5, longitude: 8.5 },
  { name: "Philippines", latitude: 12.9, longitude: 121.8 },
  { name: "Poland", latitude: 51.9, longitude: 19.1 },
  { name: "Portugal", latitude: 39.4, longitude: -8.2 },
  { name: "Romania", latitude: 45.9, longitude: 24.9 },
  { name: "Saudi Arabia", latitude: 23.9, longitude: 45.1 },
  { name: "Serbia", latitude: 44.0, longitude: 21.0 },
  { name: "Singapore", latitude: 1.35, longitude: 103.8 },
  { name: "Slovakia", latitude: 48.7, longitude: 19.7 },
  { name: "Slovenia", latitude: 46.2, longitude: 14.8 },
  { name: "South Africa", latitude: -30.6, longitude: 22.9 },
  { name: "South Korea", latitude: 35.9, longitude: 127.8, aliases: ["Korea, Republic of"] },
  { name: "Spain", latitude: 40.5, longitude: -3.7 },
  { name: "Sweden", latitude: 60.1, longitude: 18.6 },
  { name: "Switzerland", latitude: 46.8, longitude: 8.2 },
  { name: "Taiwan", latitude: 23.7, longitude: 121.0 },
  { name: "Thailand", latitude: 15.9, longitude: 100.9 },
  { name: "Turkey", latitude: 39.0, longitude: 35.2, aliases: ["Türkiye"] },
  { name: "Ukraine", latitude: 48.4, longitude: 31.2 },
  { name: "United Arab Emirates", latitude: 23.4, longitude: 53.8, aliases: ["UAE"] },
  { name: "United Kingdom", latitude: 55.4, longitude: -3.4, aliases: ["UK", "Great Britain"] },
  { name: "United States", latitude: 39.8, longitude: -98.6, aliases: ["US", "USA", "United States of America"] },
  { name: "Vietnam", latitude: 14.1, longitude: 108.3, aliases: ["Viet Nam"] },
];

function normalizedLabel(value: string) {
  return value.normalize("NFKC").replace(/\./g, "").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
}

const LOCATION_BY_LABEL = new Map<string, CoverageLocation>();
for (const location of COVERAGE_LOCATIONS) {
  LOCATION_BY_LABEL.set(normalizedLabel(location.name), location);
  for (const alias of location.aliases ?? []) {
    LOCATION_BY_LABEL.set(normalizedLabel(alias), location);
  }
}

const GLOBAL_LABELS = new Set(["global", "worldwide", "international", "world"]);

function labelsForCoverage(value: string) {
  const whole = normalizedLabel(value);
  if (LOCATION_BY_LABEL.has(whole) || GLOBAL_LABELS.has(whole)) return [value.trim()];
  return value.split(/\s*(?:\/|;|\||,)\s*/u).map((part) => part.trim()).filter(Boolean);
}

export function coverageFilterValues(countryRegion: string) {
  const values = new Set<string>();
  const supplied = countryRegion.trim();
  if (supplied === UNSPECIFIED_COUNTRY_REGION) return [UNSPECIFIED_COUNTRY_REGION];
  if (supplied) values.add(supplied);
  for (const label of labelsForCoverage(countryRegion)) {
    const normalized = normalizedLabel(label);
    if (GLOBAL_LABELS.has(normalized)) {
      values.add("Global");
      continue;
    }
    const location = LOCATION_BY_LABEL.get(normalized);
    values.add(location?.name ?? label.trim());
  }
  return [...values].filter(Boolean);
}

function coverageSourceKey(record: CoverageSource) {
  const raw = record.documentation_url || record.source_url || record.website_url;
  if (raw) {
    try {
      const url = new URL(raw);
      url.hash = "";
      if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/u, "");
      return url.toString();
    } catch {
      return raw.normalize("NFKC").trim();
    }
  }
  return normalizedLabel(record.company_name || record.api_name || "unknown source");
}

export function summarizeCoverage(records: CoverageSource[]): CoverageSummary {
  const activeRecords = records.filter((record) => record.is_active !== false);
  const pointCounts = new Map<string, { operations: number; sources: Set<string> }>();
  const otherCounts = new Map<string, { name: string; operations: number; sources: Set<string> }>();
  const allSources = new Set<string>();
  let globalOperations = 0;
  let unspecifiedOperations = 0;

  for (const record of activeRecords) {
    const source = coverageSourceKey(record);
    allSources.add(source);
    const countryRegion = countryRegionForRecord(record);
    if (countryRegion === UNSPECIFIED_COUNTRY_REGION) {
      unspecifiedOperations += 1;
      continue;
    }

    let mappedForRecord = false;
    let globalForRecord = false;
    const locationsForRecord = new Set<string>();
    const otherLabelsForRecord = new Set<string>();

    for (const label of labelsForCoverage(countryRegion)) {
      const normalized = normalizedLabel(label);
      if (GLOBAL_LABELS.has(normalized)) {
        globalForRecord = true;
        continue;
      }
      const location = LOCATION_BY_LABEL.get(normalized);
      if (location) {
        mappedForRecord = true;
        locationsForRecord.add(location.name);
      } else if (label.trim()) {
        otherLabelsForRecord.add(label.trim());
      }
    }

    if (globalForRecord) globalOperations += 1;
    for (const name of locationsForRecord) {
      const aggregate = pointCounts.get(name) ?? { operations: 0, sources: new Set<string>() };
      aggregate.operations += 1;
      aggregate.sources.add(source);
      pointCounts.set(name, aggregate);
    }
    for (const name of otherLabelsForRecord) {
      const key = normalizedLabel(name);
      const aggregate = otherCounts.get(key) ?? { name, operations: 0, sources: new Set<string>() };
      aggregate.operations += 1;
      aggregate.sources.add(source);
      otherCounts.set(key, aggregate);
    }
    if (!mappedForRecord && !globalForRecord && otherLabelsForRecord.size === 0) {
      unspecifiedOperations += 1;
    }
  }

  const points = [...pointCounts].map(([name, aggregate]) => {
    const location = LOCATION_BY_LABEL.get(normalizedLabel(name))!;
    return {
      name: location.name,
      operations: aggregate.operations,
      sources: aggregate.sources.size,
      latitude: location.latitude,
      longitude: location.longitude,
    };
  }).sort((a, b) => b.operations - a.operations || a.name.localeCompare(b.name, "en"));
  const otherRegions = [...otherCounts].map(([, aggregate]) => ({
    name: aggregate.name,
    operations: aggregate.operations,
    sources: aggregate.sources.size,
  })).sort((a, b) => b.operations - a.operations || a.name.localeCompare(b.name, "en"));

  return {
    totalOperations: activeRecords.length,
    totalSources: allSources.size,
    representedLocations: points.length + otherRegions.length,
    globalOperations,
    unspecifiedOperations,
    points,
    otherRegions,
  };
}
