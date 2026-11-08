/**
 * Check item 2.0b · invoice standard (issue #42).
 *
 * Formats (Check 1) say how an invoice is written; the standard says which
 * rules it follows. A real call showed why both are needed: NormAPI Generate
 * writes XRechnung 3.0.2 and Peppol Validator reads Peppol BIS Billing 3.0 —
 * same XML, but the validator rejects the invoice.
 *
 * What each side follows: its directional claims in
 * api_invoice_standard_capability (output for the source, input for the
 * target; a validator that hands on its document is read on its input side),
 * or, when it has none, the catalogue label apis.invoice_standard. Syntaxes
 * (UBL, CII), file types and "N/A" are not standards and are dropped.
 *
 * What a validator actually checks is the document's specification
 * identifier (cbc:CustomizationID), recorded per standard in
 * invoice_standards.csv. A CIUS identifier extends EN 16931's
 * (urn:cen.eu:en16931:2017#compliant#…), so an EN 16931 validator accepts any
 * CIUS, while a CIUS validator accepts only its own identifier: NormAPI's
 * provider confirmed on 12 October 2026 that its XRechnung output "follows EN
 * 16931, but it carries XRechnung's CustomizationID, so Peppol BIS validation
 * rejects it".
 *
 * A side listing a CIUS and its parent (NormAPI: EN 16931, XRechnung) writes
 * the CIUS: the parent is dropped from that side.
 *
 * Relations (invoice_standards.csv: EN 16931 is the parent of the CIUS rows):
 *   same / version_differs   the same standard
 *   subset    the source follows a CIUS of the target's standard
 *   superset  the target requires a CIUS of the source's standard
 *   fillable  listed in invoice_standard_exceptions.csv (Peppol BIS 3.0 to
 *             PINT A-NZ: client, 10 October 2026)
 *   disjoint  anything else, including two CIUS of the same parent
 *
 * Verdict (decided 7 and 12 October 2026): pass when any combination is same,
 * subset or fillable; unknown — invoice_standard_unconfirmed — when the only
 * overlap is superset (the source is known to follow EN 16931 but not which
 * identifier it writes); not_voting when a side records no standard or the
 * only overlap is a different version (information only); fail —
 * invoice_standard_mismatch — otherwise. fail and unknown both block before
 * field mapping.
 */
import { invoiceStandards } from "../compatibility/data/generated/invoice_standards.ts";
import { invoiceStandardExceptions } from "../compatibility/data/generated/invoice_standard_exceptions.ts";
import type { ApiSideInput, ResolvedStandard, StandardRelation, StandardResult, StandardReview } from "./types.ts";

const ROWS = invoiceStandards.map((r) => ({ ...r, regex: new RegExp(r.pattern, "i") }));
const key = (v: string) => v.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Canonical form of one stored value; null for a syntax, a file type or "N/A". */
export function resolveStandard(raw: string): ResolvedStandard | null {
  const value = raw.trim();
  if (value === "") return null;
  for (const row of ROWS) {
    const m = value.match(row.regex);
    if (!m) continue;
    if (row.kind === "syntax" || row.kind === "none") return null;
    const rest = value.replace(m[0], " ");
    const version = rest.match(/\bv?(\d+(?:\.\d+)+|\d+)\b(?!.*\d)/i)?.[1] ?? null;
    // The canonical name of a CIUS may already carry its version (Peppol BIS Billing 3.0).
    const named = row.standard.match(/(\d+(?:\.\d+)+)$/)?.[1] ?? null;
    return { raw: value, standard: row.standard, version: named ?? version, parent: row.parent || null, customization_id: row.customization_id || null };
  }
  const version = value.match(/\bv?(\d+(?:\.\d+)+)\b(?!.*\d)/i)?.[1] ?? null;
  const name = version ? value.replace(new RegExp(`\\s*v?${version.replace(/\./g, "\\.")}\\s*`, "i"), " ").trim() : value;
  return { raw: value, standard: name, version, parent: null, customization_id: null };
}

function standardsOf(side: ApiSideInput, direction: "input" | "output") {
  const claims = (side.standard_claims ?? []).filter((c) => c.direction === direction && c.status !== "rejected");
  const fromClaims = claims.map((c) => resolveStandard([c.standard, c.version ?? ""].join(" ")));
  if (claims.length > 0) {
    // The request option a claim needs, keyed like dedupe() keys a standard.
    const conditions = new Map<string, string>();
    claims.forEach((c, i) => {
      const r = fromClaims[i];
      const condition = c.condition?.trim();
      if (r && condition) conditions.set(`${key(r.standard)}|${r.version ?? ""}`, condition);
    });
    return {
      basis: "claims" as const,
      standards: dedupe(fromClaims),
      unreviewed: claims.some((c) => c.status !== "confirmed"),
      conditions,
    };
  }
  const label = (side.api.invoice_standard ?? []).map(resolveStandard);
  const standards = dedupe(label);
  return { basis: standards.length > 0 ? ("catalogue" as const) : ("none" as const), standards, unreviewed: false, conditions: new Map<string, string>() };
}

function dedupe(values: Array<ResolvedStandard | null>): ResolvedStandard[] {
  const seen = new Map<string, ResolvedStandard>();
  for (const v of values) if (v) seen.set(`${key(v.standard)}|${v.version ?? ""}`, v);
  const all = [...seen.values()];
  // A parent listed next to one of its CIUS is implied by it, not a second output.
  const parents = new Set(all.map((v) => v.parent).filter((p): p is string => !!p).map(key));
  return all.filter((v) => !parents.has(key(v.standard)));
}

function reviewOf(side: ReturnType<typeof standardsOf>, direction: StandardReview["direction"]): StandardReview {
  const status = side.standards.length === 0 ? "not_recorded"
    : side.basis !== "claims" ? "not_assessed"
    : side.unreviewed ? "unreviewed" : "confirmed";
  return { direction, status };
}

export function relationOf(s: ResolvedStandard, t: ResolvedStandard): { relation: StandardRelation; note: string | null } {
  if (key(s.standard) === key(t.standard)) {
    const differ = s.version && t.version && key(s.version) !== key(t.version);
    return differ ? { relation: "version_differs", note: `${s.version} vs ${t.version}` } : { relation: "same", note: null };
  }
  const exception = invoiceStandardExceptions.find((e) => key(e.source) === key(s.standard) && key(e.target) === key(t.standard));
  if (exception) return { relation: exception.relation as StandardRelation, note: exception.note };
  if (s.parent && key(s.parent) === key(t.standard)) return { relation: "subset", note: null };
  if (t.parent && key(t.parent) === key(s.standard)) return { relation: "superset", note: null };
  return { relation: "disjoint", note: null };
}

/**
 * @param sourceHandsOnInput true when the source is a validator passing on
 * the document it received: its standards are read on its input side.
 */
export function runStandard(source: ApiSideInput, target: ApiSideInput, sourceHandsOnInput = false): StandardResult {
  const src = standardsOf(source, sourceHandsOnInput ? "input" : "output");
  const tgt = standardsOf(target, "input");
  const base: StandardResult = {
    status: "not_voting",
    reason_code: null,
    source_standards: src.standards,
    target_standards: tgt.standards,
    source_basis: src.basis,
    target_basis: tgt.basis,
    review: {
      source: reviewOf(src, sourceHandsOnInput ? "input" : "output"),
      target: reviewOf(tgt, "input"),
    },
    matches: [],
    conditions: [],
    flags: src.unreviewed || tgt.unreviewed ? ["claims_unreviewed"] : [],
  };
  if (src.standards.length === 0 || tgt.standards.length === 0) {
    return { ...base, flags: [...base.flags, "standard_not_recorded"] };
  }
  const matches: StandardResult["matches"] = [];
  for (const s of src.standards) for (const t of tgt.standards) {
    const { relation, note } = relationOf(s, t);
    if (relation !== "disjoint") matches.push({ source: s.raw, target: t.raw, relation, note });
  }
  const passing = matches.filter((m) => m.relation === "same" || m.relation === "subset" || m.relation === "fillable");
  if (passing.length > 0) {
    const flags = [...base.flags];
    if (passing.every((m) => m.relation === "fillable")) flags.push("fill_required");
    // A matched standard that a side only writes or reads under a request
    // option (beliq generates Peppol BIS only with standard=peppol-bis, as
    // the real calls of 26 and 28 September did): the pair passes, and the
    // caller is told what to set. Taken over from the composition layer's
    // check on 14 October 2026.
    const conditions: StandardResult["conditions"] = [];
    const conditionOf = (side: "source" | "target", r: ResolvedStandard) => {
      const found = (side === "source" ? src : tgt).conditions.get(`${key(r.standard)}|${r.version ?? ""}`);
      if (found && !conditions.some((c) => c.side === side && c.standard === r.raw)) conditions.push({ side, standard: r.raw, condition: found });
    };
    for (const m of passing) {
      const s = src.standards.find((x) => x.raw === m.source), t = tgt.standards.find((x) => x.raw === m.target);
      if (s) conditionOf("source", s);
      if (t) conditionOf("target", t);
    }
    if (conditions.length > 0) flags.push("configuration_required");
    return { ...base, status: "pass", matches, conditions, flags };
  }
  if (matches.some((m) => m.relation === "superset")) {
    return { ...base, status: "unknown", reason_code: "invoice_standard_unconfirmed", matches, flags: [...base.flags, "customization_unconfirmed"] };
  }
  if (matches.length > 0) return { ...base, matches, flags: [...base.flags, "version_differs"] };
  return { ...base, status: "fail", reason_code: "invoice_standard_mismatch" };
}
