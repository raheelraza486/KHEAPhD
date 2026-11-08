export const ALL_COUNTRY_REGIONS = "All countries / regions";
export const UNSPECIFIED_COUNTRY_REGION = "Other / unspecified";

export type CountryRegionSource = {
  country_region?: string;
  api_name?: string;
  official_api_name?: string;
  company_name?: string;
  official_company_name?: string;
  documentation_url?: string;
  website_url?: string;
  source_url?: string;
  api_endpoint?: string;
};

// Complete place names are intentionally preferred to abbreviations: a short
// token such as "IN" or "US" occurs too often in product names to be reliable.
const NAME_SIGNALS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bargentina\b/i, "Argentina"],
  [/\bchile\b/i, "Chile"],
  [/\bserbia\b/i, "Serbia"],
  [/\bsouth africa\b/i, "South Africa"],
  [/\becuador\b/i, "Ecuador"],
  [/\begypt(?:ian)?\b/i, "Egypt"],
  [/\bjordan\b/i, "Jordan"],
  [/\bkenya\b/i, "Kenya"],
  [/\bperu\b/i, "Peru"],
  [/\brwanda\b/i, "Rwanda"],
  [/\bzambia\b/i, "Zambia"],
  [/\bsaudi arabia\b/i, "Saudi Arabia"],
  [/\bnew zealand\b/i, "New Zealand"],
  [/\bunited arab emirates\b/i, "United Arab Emirates"],
  [/\bunited kingdom\b/i, "United Kingdom"],
  [/\bunited states(?: of america)?\b/i, "United States"],
  [/\bsouth korea\b/i, "South Korea"],
  [/\b(?:czech republic|czechia)\b/i, "Czech Republic"],
  [/\beuropean union\b/i, "European Union"],
  [/\baustralia\b/i, "Australia"],
  [/\baustria\b/i, "Austria"],
  [/\bbelgium\b/i, "Belgium"],
  [/\bbrazil\b/i, "Brazil"],
  [/\bbulgaria\b/i, "Bulgaria"],
  [/\bcanada\b/i, "Canada"],
  [/\bchina\b/i, "China"],
  [/\bcolombia\b/i, "Colombia"],
  [/\bcroatia\b/i, "Croatia"],
  [/\bdenmark\b/i, "Denmark"],
  [/\bestonia\b/i, "Estonia"],
  [/\bfinland\b/i, "Finland"],
  [/\bfrance\b/i, "France"],
  [/\bgermany\b/i, "Germany"],
  [/\bgreece\b/i, "Greece"],
  [/\bhungary\b/i, "Hungary"],
  [/\bindia\b/i, "India"],
  [/\bindonesia\b/i, "Indonesia"],
  [/\bireland\b/i, "Ireland"],
  [/\bisrael\b/i, "Israel"],
  [/\bitaly\b/i, "Italy"],
  [/\bjapan\b/i, "Japan"],
  [/\bmalaysia\b/i, "Malaysia"],
  [/\bmexico\b/i, "Mexico"],
  [/\bnetherlands\b/i, "Netherlands"],
  [/\bnorway\b/i, "Norway"],
  [/\bphilippines\b/i, "Philippines"],
  [/\bpoland\b/i, "Poland"],
  [/\bportugal\b/i, "Portugal"],
  [/\bromania\b/i, "Romania"],
  [/\bsingapore\b/i, "Singapore"],
  [/\bslovakia\b/i, "Slovakia"],
  [/\bslovenia\b/i, "Slovenia"],
  [/\bspain\b/i, "Spain"],
  [/\bsweden\b/i, "Sweden"],
  [/\bswitzerland\b/i, "Switzerland"],
  [/\btaiwan\b/i, "Taiwan"],
  [/\bthailand\b/i, "Thailand"],
  [/\bturkey\b/i, "Turkey"],
  [/\bvietnam\b/i, "Vietnam"],
  [/中国/u, "China"],
  [/日本/u, "Japan"],
  [/韩国/u, "South Korea"],
];

// These providers use a generic top-level domain, so the hostname is a more
// useful signal than its suffix. Keep this list small and evidence-based.
const KNOWN_HOSTS: ReadonlyArray<readonly [string, string]> = [
  ["irisgst.com", "India"],
  ["facturapi.io", "Mexico"],
  ["nuonuo.com", "China"],
  ["xero.com", "New Zealand / global"],
];

// Country-code domains with widespread unrelated commercial use (.io, .ai,
// .co, .me, .tv, etc.) are deliberately absent.
const COUNTRY_CODE_DOMAINS: Readonly<Record<string, string>> = {
  ar: "Argentina",
  cl: "Chile",
  rs: "Serbia",
  ec: "Ecuador",
  eg: "Egypt",
  jo: "Jordan",
  ke: "Kenya",
  pe: "Peru",
  rw: "Rwanda",
  zm: "Zambia",
  at: "Austria",
  au: "Australia",
  be: "Belgium",
  bg: "Bulgaria",
  br: "Brazil",
  ca: "Canada",
  ch: "Switzerland",
  cn: "China",
  cz: "Czech Republic",
  de: "Germany",
  dk: "Denmark",
  ee: "Estonia",
  es: "Spain",
  eu: "European Union",
  fi: "Finland",
  fr: "France",
  gr: "Greece",
  hk: "Hong Kong",
  hr: "Croatia",
  hu: "Hungary",
  id: "Indonesia",
  ie: "Ireland",
  il: "Israel",
  in: "India",
  it: "Italy",
  jp: "Japan",
  kr: "South Korea",
  mx: "Mexico",
  my: "Malaysia",
  nl: "Netherlands",
  no: "Norway",
  nz: "New Zealand",
  ph: "Philippines",
  pl: "Poland",
  pt: "Portugal",
  ro: "Romania",
  sa: "Saudi Arabia",
  se: "Sweden",
  sg: "Singapore",
  si: "Slovenia",
  sk: "Slovakia",
  th: "Thailand",
  tr: "Turkey",
  tw: "Taiwan",
  ua: "Ukraine",
  uk: "United Kingdom",
  vn: "Vietnam",
  za: "South Africa",
};

function hostname(value: string | undefined) {
  if (!value) return "";
  try {
    return new URL(value).hostname.toLocaleLowerCase("en-US").replace(/\.$/, "");
  } catch {
    return "";
  }
}

function hostMatches(host: string, domain: string) {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Return the recorded country/region, or a conservative display fallback for
 * legacy rows. Fallback inference is UI-only and never writes guessed data to
 * the catalogue.
 */
export function countryRegionForRecord(record: CountryRegionSource) {
  const explicit = record.country_region?.trim();
  if (explicit) return explicit;

  const names = [
    record.company_name,
    record.official_company_name,
    record.api_name,
    record.official_api_name,
  ].filter(Boolean).join(" ");
  for (const [pattern, countryRegion] of NAME_SIGNALS) {
    if (pattern.test(names)) return countryRegion;
  }

  const hosts = [
    record.documentation_url,
    record.website_url,
    record.source_url,
    record.api_endpoint,
  ].map(hostname).filter(Boolean);
  for (const host of hosts) {
    for (const [domain, countryRegion] of KNOWN_HOSTS) {
      if (hostMatches(host, domain)) return countryRegion;
    }
    const countryCode = host.split(".").at(-1) ?? "";
    if (COUNTRY_CODE_DOMAINS[countryCode]) return COUNTRY_CODE_DOMAINS[countryCode];
  }

  return UNSPECIFIED_COUNTRY_REGION;
}

export function countryRegionOptions(records: CountryRegionSource[]) {
  const values = new Set(records.map(countryRegionForRecord));
  return [...values].sort((a, b) => {
    if (a === UNSPECIFIED_COUNTRY_REGION) return 1;
    if (b === UNSPECIFIED_COUNTRY_REGION) return -1;
    return a.localeCompare(b, "en");
  });
}

/** A location inferred from a name or domain is a suggestion, not confirmed coverage. */
export function countryRegionEvidence(record: CountryRegionSource) {
  const value = countryRegionForRecord(record);
  if (record.country_region?.trim()) return { label: value, source: "recorded" as const, note: "Recorded in this API listing. Check the documentation for supported markets." };
  if (value !== UNSPECIFIED_COUNTRY_REGION) return { label: value, source: "inferred" as const, note: "Suggested by the provider name or source URL. Service coverage has not been confirmed." };
  return { label: "Not recorded", source: "unknown" as const, note: "No country or region is recorded. This does not mean the API is available worldwide." };
}
