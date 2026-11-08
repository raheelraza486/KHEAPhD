import type { ProcessStep } from "./types.ts";
import type { CandidateApi } from "./task-candidates.ts";

const au = /\b(?:australia(?:n)?|AU|AUS)\b|澳大利亚|澳洲|\bPINT[\s_-]*(?:A[\s-]*NZ|AU[\s-]*NZ)\b/i;
const pintAnz = /\bPINT[\s_-]*(?:A[\s-]*NZ|AU[\s-]*NZ)\b/i;
export const requestsAustralianRules = (step: ProcessStep) => step.category === "Validation"
  && (au.test(step.rule_set ?? "") || (au.test(step.task) && /\brules?\b|\bPINT\b|\bcompliance\b|\binvoice\b|规则|发票|合规/i.test(step.task)));

/** Catalogue evidence of rule support, not a jurisdiction-compliance verdict. Country alone is insufficient. */
export function australianRuleSupport(api: CandidateApi): "supported" | "unverified" | "rejected" {
  const claims = (api.standard_capabilities ?? []).filter(row => row.direction === "input"
    && /^https?:\/\/\S+$/i.test(row.evidence_url) && au.test(`${row.standard} ${row.profile}`));
  if (claims.some(row => row.status === "rejected")) return "rejected";
  if (claims.some(row => row.status === "confirmed")) return "supported";
  const labels = [api.api_name, api.official_api_name, ...(api.business_rules ?? []), ...(api.invoice_standard ?? [])].filter(Boolean).join(" ");
  const description = [api.description, api.instructions].filter(Boolean).join(" ");
  const evidence = `${labels} ${description}`;
  if (/(?:not|no|without|doesn't|does not)[^.\n]{0,45}(?:Australian|Australia|PINT[\s_-]*A[\s-]*NZ)/i.test(evidence)) return "rejected";
  if (pintAnz.test(labels) || /\b(?:Australian|Australia|AU|AUS)\s+(?:invoice\s+)?(?:rules|validation|compliance)\b/i.test(evidence)
    || /\bAustralian(?:\s+(?:and|\/|New|Zealand|invoice)){0,5}\s+(?:rules|validation|compliance)\b/i.test(evidence)
    || /\bPINT\s+Australia\s*(?:\/|and)\s*New\s+Zealand\b/i.test(evidence)
    || /(?:澳洲|澳大利亚).{0,16}(?:规则|校验|验证)/.test(evidence)) return "supported";
  return "unverified";
}
