import type { ApiRecord } from "@/lib/types";
import { catalogCardSummary } from "@/lib/catalog-card-summary";
import CountryRegionLabel from "@/components/country-region-label";
import ProductIcon from "@/components/product-icon";

type Props = {
  record: ApiRecord;
  category: string;
  categoryTone: string;
  status: string;
  statusClass: string;
  statusMeaning: string;
  authentication: string;
  selected: boolean;
  onOpen: () => void;
};

export default function ApiCatalogueCard({ record, category, categoryTone, status, statusClass, statusMeaning, authentication, selected, onOpen }: Props) {
  const summary = catalogCardSummary(record);
  return <button type="button" className={`api-card api-summary-card${selected ? " selected" : ""}`} onClick={onOpen} aria-pressed={selected} aria-controls="api-detail" aria-label={`View details for ${record.api_name}`}>
    <span className="api-card-topline"><span className={`pill ${categoryTone}`}>{category}</span><span className={`status-label ${statusClass}`} title={statusMeaning}>{status}</span></span>
    <strong className="api-summary-title" title={record.description || record.api_name}>{summary.title}</strong>
    {summary.title !== record.api_name && <span className="api-summary-name" title={record.api_name}>{record.api_name}</span>}
    {summary.description && <span className="api-card-description" title={summary.description}>{summary.description}</span>}
    <span className="api-summary-provider"><span className="company-name">{record.company_name}</span><CountryRegionLabel record={record} /></span>
    <span className="api-summary-fields">
      <span><b>Needs</b><span>{summary.input}</span></span>
      <span><b>Returns</b><span>{summary.output}</span></span>
    </span>
    <span className="api-summary-notes"><b>Usage notes</b>{summary.rules.length
      ? <span title={summary.rules.join(" ")}>{summary.rules.join(" ")}</span>
      : <span>Check usage requirements in the API details.</span>}
      {summary.moreRules > 0 && <small>+{summary.moreRules} more {summary.moreRules === 1 ? "requirement" : "requirements"} in details</small>}
    </span>
    <span className="api-summary-footer"><span title={record.authentication_details || authentication}>Provider access · {authentication || "Not recorded"}</span><span>View details<ProductIcon name="arrow" /></span></span>
  </button>;
}
