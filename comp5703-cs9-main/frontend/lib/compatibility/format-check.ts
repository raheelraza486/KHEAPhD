import type { CheckOutcome } from "./types.ts";

/**
 * Canonical data-format names used by the format check. The repository's
 * input_formats / output_formats columns hold free text ("UBL XML",
 * "JSON | UBL XML", "Validation Report"...), so every value is normalised
 * before the two sides are intersected.
 */
export type CanonicalFormat = "JSON" | "XML" | "UBL" | "CSV" | "PDF" | "EDIFACT";

/**
 * Values that describe content rather than a data format. They are ignored
 * by the check and reported back so the record can be cleaned up later.
 */
const NOT_A_FORMAT = new Set([
  "validation report",
  "status codes",
  "status code",
  "email receipts",
  "images",
  "scans",
  "other",
]);

/**
 * Map one raw token to zero or more canonical formats.
 * "UBL XML" is both UBL (the document standard) and XML (the syntax), so it
 * yields both — a target that accepts plain XML can at least parse it.
 */
export function normalizeFormatToken(raw: string): CanonicalFormat[] {
  const t = raw.trim().toLowerCase();
  if (t === "") return [];
  if (NOT_A_FORMAT.has(t)) return [];
  if (t.includes("json")) return ["JSON"];
  if (t.includes("ubl")) return ["UBL", "XML"];
  if (t.includes("edifact")) return ["EDIFACT"];
  if (t.includes("xml")) return ["XML"];
  if (t.includes("csv")) return ["CSV"];
  if (t.includes("pdf")) return ["PDF"];
  return [];
}

export interface NormalizedFormats {
  formats: Set<CanonicalFormat>;
  /** Raw values that were not recognised as a data format. */
  ignored: string[];
}

/**
 * Spellings the repository has already mapped to one canonical name
 * (public.format_alias: alias -> canonical). Keys are compared
 * case-insensitively and trimmed. The table is the curated source of truth;
 * the built-in token rules only catch what it does not list yet.
 */
export type FormatAliasMap = ReadonlyMap<string, string>;

export function buildFormatAliasMap(rows: readonly { alias: string; canonical: string }[]): FormatAliasMap {
  const map = new Map<string, string>();
  for (const { alias, canonical } of rows) {
    const key = alias.trim().toLowerCase();
    if (key !== "") map.set(key, canonical.trim());
  }
  return map;
}

/**
 * Normalise a whole column value. Accepts the text[] form the repository
 * stores as well as a single "A | B" string from older exports. When an alias
 * map is given, each piece is first rewritten to its canonical spelling.
 */
export function normalizeFormats(
  values: readonly string[] | string | null | undefined,
  aliases?: FormatAliasMap,
): NormalizedFormats {
  const list = values == null ? [] : typeof values === "string" ? values.split("|") : values;
  const formats = new Set<CanonicalFormat>();
  const ignored: string[] = [];
  for (const raw of list) {
    for (const rawPiece of raw.split("|")) {
      const piece = aliases?.get(rawPiece.trim().toLowerCase()) ?? rawPiece;
      const canon = normalizeFormatToken(piece);
      if (canon.length === 0) {
        if (piece.trim() !== "") ignored.push(piece.trim());
      } else {
        for (const f of canon) formats.add(f);
      }
    }
  }
  return { formats, ignored };
}

export interface FormatCheckResult extends CheckOutcome {
  source_output_formats: CanonicalFormat[];
  target_input_formats: CanonicalFormat[];
  common_formats: CanonicalFormat[];
  ignored_values: string[];
}

function fmt(list: Iterable<string>): string {
  return `[${[...list].join(", ")}]`;
}

/**
 * Format check: can the target read what the source writes?
 *   both sides declare something and share a format -> compatible
 *   both declare something, nothing shared            -> incompatible
 *   either side declares nothing recognisable         -> unknown
 */
export function checkFormatCompatibility(
  sourceName: string,
  sourceOutputFormats: readonly string[] | string | null | undefined,
  targetName: string,
  targetInputFormats: readonly string[] | string | null | undefined,
  aliases?: FormatAliasMap,
): FormatCheckResult {
  const src = normalizeFormats(sourceOutputFormats, aliases);
  const tgt = normalizeFormats(targetInputFormats, aliases);
  const sourceOut = [...src.formats];
  const targetIn = [...tgt.formats];
  const common = sourceOut.filter((f) => tgt.formats.has(f));
  const ignored = [...src.ignored, ...tgt.ignored];

  let status: CheckOutcome["status"];
  let reason: string;
  if (sourceOut.length === 0 || targetIn.length === 0) {
    status = "unknown";
    reason =
      sourceOut.length === 0
        ? `'${sourceName}' declares no recognised output format.`
        : `'${targetName}' declares no recognised input format.`;
  } else if (common.length === 0) {
    status = "incompatible";
    reason = `'${sourceName}' outputs ${fmt(sourceOut)} but '${targetName}' only accepts ${fmt(targetIn)}.`;
  } else {
    status = "compatible";
    reason = `Both sides support ${fmt(common)} ('${sourceName}' outputs ${fmt(sourceOut)}, '${targetName}' accepts ${fmt(targetIn)}).`;
  }

  return {
    status,
    reason,
    source_output_formats: sourceOut,
    target_input_formats: targetIn,
    common_formats: common,
    ignored_values: ignored,
  };
}
