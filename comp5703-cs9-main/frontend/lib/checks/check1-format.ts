/**
 * Check 1 · format check (Compatibility Check Manual v1.0, chapter 6).
 *
 * 1.1 Every value of `output_formats` / `input_formats` is looked up in
 *     `format_alias`; unrecognised values are reported, never guessed.
 * 1.2 A target without a request-direction schema has its input in the URL
 *     parameters: Check 1 does not vote, flag `input_in_parameters`; a target
 *     with neither schema nor parameters is `target_no_input_schema`.
 * 1.3 Pass when the two canonical sets intersect; fail when both are non-empty
 *     and disjoint; `source_no_format` / `target_no_format` when a side is empty.
 */
import { declaredDocuments, effectiveFormats, schemasCarrying } from "./documents.ts";
import type { Check1Result, FormatAliasRow, FormatOption, PairInput, SchemaRecord } from "./types.ts";

/**
 * Document standards that a target accepting the underlying syntax can parse
 * (Check Manual §6.2). A Hybrid PDF (ZUGFeRD / Factur-X) is a PDF to a target
 * that takes any PDF; a plain PDF is not a Hybrid PDF.
 */
const PARSABLE_AS: Record<string, string> = { UBL: "XML", "Hybrid PDF": "PDF" };

export interface NormalisedFormats {
  formats: string[];
  unrecognised: string[];
}

export function normaliseFormats(values: readonly string[] | null | undefined, aliases: readonly FormatAliasRow[]): NormalisedFormats {
  const map = new Map<string, string>();
  for (const { alias, canonical } of aliases) map.set(alias.trim().toLowerCase(), canonical.trim());
  const formats = new Set<string>();
  const unrecognised: string[] = [];
  for (const raw of values ?? []) {
    const key = (raw ?? "").trim().toLowerCase();
    if (key === "") continue;
    const canonical = map.get(key);
    if (canonical === undefined) unrecognised.push(raw);
    else formats.add(canonical);
  }
  return { formats: [...formats].sort(), unrecognised };
}

export function commonFormats(sourceOut: readonly string[], targetIn: readonly string[]): string[] {
  const accepted = new Set(targetIn);
  const common = new Set<string>();
  for (const f of sourceOut) {
    if (accepted.has(f)) common.add(f);
    else if (PARSABLE_AS[f] && accepted.has(PARSABLE_AS[f])) common.add(f);
  }
  return [...common].sort();
}

/**
 * §6.4 on the page: everything either side declares, annotated. A format is
 * offered even when the other side does not accept it or no schema is stored
 * for it — the annotation is the answer to "why does this not work", and
 * hiding the option would only make the page choose silently.
 *
 * Order: usable first (common to both sides and backed by a schema on both),
 * then the rest of the common ones, then one-sided declarations, and last the
 * values `format_alias` does not know, which cannot be chosen. Names break
 * ties so the list never depends on the order rows came back in.
 */
function formatOptions(
  source: NormalisedFormats,
  target: NormalisedFormats,
  sourceSchemas: readonly SchemaRecord[],
  targetSchemas: readonly SchemaRecord[],
  sourceCategory?: string | null,
  targetCategory?: string | null,
  sourceDocuments?: readonly string[],
  targetDocuments?: readonly string[],
): FormatOption[] {
  const responses = sourceSchemas.filter((s) => s.direction === "response");
  const requests = targetSchemas.filter((s) => s.direction === "request");
  const commonFromSource = new Set(commonFormats(source.formats, target.formats));
  // The target-side name of the same agreement: a source UBL meets a target XML.
  const commonOnTarget = new Set(
    source.formats.flatMap((f) => target.formats.filter((t) => t === f || PARSABLE_AS[f] === t)),
  );

  const recognised: FormatOption[] = [...new Set([...source.formats, ...target.formats])].map((format) => ({
    format,
    recognised: true,
    in_source: source.formats.includes(format),
    in_target: target.formats.includes(format),
    common: commonFromSource.has(format) || commonOnTarget.has(format),
    source_has_schema: schemasCarrying(responses, format, sourceCategory, sourceDocuments).length > 0,
    target_has_schema: schemasCarrying(requests, format, targetCategory, targetDocuments).length > 0,
    selectable: true,
  }));

  const rank = (o: FormatOption) =>
    o.common && o.source_has_schema && o.target_has_schema ? 0 : o.common ? 1 : 2;
  recognised.sort((a, b) => rank(a) - rank(b) || a.format.localeCompare(b.format));

  const unknown: FormatOption[] = [...new Set([...source.unrecognised, ...target.unrecognised])]
    .sort((a, b) => a.localeCompare(b))
    .map((format) => ({
      format,
      recognised: false,
      in_source: source.unrecognised.includes(format),
      in_target: target.unrecognised.includes(format),
      common: false,
      source_has_schema: false,
      target_has_schema: false,
      selectable: false,
    }));

  return [...recognised, ...unknown];
}

/** The format compared when the page has not chosen one: the first usable option. */
export function defaultFormat(options: readonly FormatOption[]): string | null {
  const usable = options.find((o) => o.selectable && o.common && o.source_has_schema && o.target_has_schema);
  if (usable) return usable.format;
  return options.find((o) => o.selectable && o.common)?.format ?? null;
}

export function runCheck1(input: PairInput): Check1Result {
  // Declared formats plus the document a carrier holds (#41, documents.ts).
  const src = effectiveFormats(input.source, "output", input.formatAliases);
  const tgt = effectiveFormats(input.target, "input", input.formatAliases);
  const unrecognised = [...src.unrecognised, ...tgt.unrecognised];
  const options = formatOptions(src, tgt, input.source.schemas, input.target.schemas, input.source.api.category, input.target.api.category,
    declaredDocuments(input.source, "output", input.formatAliases), declaredDocuments(input.target, "input", input.formatAliases));
  const base: Check1Result = {
    status: "pass",
    reason_code: null,
    source_formats: src.formats,
    target_formats: tgt.formats,
    common_formats: [],
    unrecognised_values: unrecognised,
    format_options: options,
    format_selected: input.selectedFormat ?? defaultFormat(options),
    flags: [],
  };

  // 1.2 — decided on the schema table, not on the format column.
  const hasRequestSchema = input.target.schemas.some((s) => s.direction === "request");
  if (!hasRequestSchema) {
    if (input.target.parameters.length > 0) return { ...base, status: "not_voting", flags: ["input_in_parameters"] };
    return { ...base, status: "unknown", reason_code: "target_no_input_schema" };
  }

  // 1.3
  if (src.formats.length === 0) return { ...base, status: "unknown", reason_code: "source_no_format" };
  if (tgt.formats.length === 0) return { ...base, status: "unknown", reason_code: "target_no_format" };
  const common = commonFormats(src.formats, tgt.formats);
  return { ...base, status: common.length > 0 ? "pass" : "fail", common_formats: common };
}
