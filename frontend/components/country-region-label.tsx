import { countryRegionEvidence, type CountryRegionSource } from "@/lib/country-region";

export default function CountryRegionLabel({ record, detailed = false }: { record: CountryRegionSource; detailed?: boolean }) {
  const region = countryRegionEvidence(record);
  return <span className={`country-region-label region-${region.source}`}>
    <strong>{region.label}</strong>
    {region.source === "inferred" && <small>Suggested location</small>}
    {detailed && <span className="country-region-note">{region.note}</span>}
  </span>;
}
