// Resolve the format an operation says it produces, separately from the HTTP
// envelope used to carry that result. A conversion endpoint may legitimately
// return application/json while placing the converted XML/PDF in a response
// property. For the catalogue's directional format fields, an explicit
// "convert X to Y" or "returns Y" statement is stronger evidence than that
// wrapper media type.

import type { Candidate } from "./types.ts";

const FORMAT_NAMES = ["JSON", "XML", "PDF", "CSV", "ZIP", "HTML"] as const;
type DeclaredFormat = (typeof FORMAT_NAMES)[number];

export type DeclaredFormatInference = {
  input: DeclaredFormat[];
  output: DeclaredFormat[];
  evidence: string;
  kind: "conversion" | "result";
};

const FORMAT_TOKEN = String.raw`(?:application\/(?:[\w.+-]+\+)?json|application\/(?:[\w.+-]+\+)?xml|application\/pdf|application\/zip|text\/xml|text\/csv|text\/html|json|xml|pdf|csv|zip|html)`;
const CONVERSION_VERB = String.raw`(?:convert(?:s|ed|ing)?|transform(?:s|ed|ing)?|translat(?:e|es|ed|ing)|serializ(?:e|es|ed|ing)|render(?:s|ed|ing)?)`;
const RESULT_VERB = String.raw`(?:return(?:s|ed|ing)?|produce(?:s|d|ing)?|output(?:s|ted|ting)?|respond(?:s|ed|ing)?\s+with|download(?:s|ed|ing)?|retrieve(?:s|d|ing)?)`;

function canonicalFormat(value: string): DeclaredFormat | null {
  const lower = value.toLowerCase();
  if (lower.includes("json")) return "JSON";
  if (lower.includes("xml")) return "XML";
  if (lower.includes("pdf")) return "PDF";
  if (lower.includes("csv")) return "CSV";
  if (lower.includes("zip")) return "ZIP";
  if (lower.includes("html")) return "HTML";
  return null;
}

function formatsIn(value: string): DeclaredFormat[] {
  const matches = value.match(new RegExp(FORMAT_TOKEN, "gi")) ?? [];
  const out: DeclaredFormat[] = [];
  for (const match of matches) {
    const format = canonicalFormat(match);
    if (format && !out.includes(format)) out.push(format);
  }
  return out;
}

function evidenceText(candidate: Candidate): string {
  return [
    candidate.operation_id,
    candidate.operation_summary,
    candidate.official_api_name,
    candidate.api_name,
    candidate.description,
    ...(candidate.operation_tags ?? []),
  ].filter(Boolean).join(". ");
}

/**
 * Infer formats only from explicit directional statements. Incidental mentions
 * such as "validates XML documents" are deliberately ignored. Clauses about
 * related/other endpoints are also excluded, because they do not describe the
 * operation being imported.
 */
export function inferDeclaredFormats(candidate: Candidate): DeclaredFormatInference | null {
  const clauses = evidenceText(candidate)
    .split(/[.;!?\n]+/u)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .filter((clause) => !/\b(?:related|other|separate)\s+(?:apis?|endpoints?|operations?)\b/i.test(clause));

  const arrowPattern = new RegExp(`(${FORMAT_TOKEN})\\s*(?:→|->|=>)\\s*(${FORMAT_TOKEN})`, "i");
  const conversionPattern = new RegExp(
    `\\b${CONVERSION_VERB}\\b[^.;!?\\n]{0,120}?(${FORMAT_TOKEN})[^.;!?\\n]{0,80}?\\b(?:to|into|as)\\b[^.;!?\\n]{0,50}?(${FORMAT_TOKEN})`,
    "i",
  );
  const renderPattern = new RegExp(
    `\\brender(?:s|ed|ing)?\\b[^.;!?\\n]{0,140}?\\b(?:to|into|as)\\b[^.;!?\\n]{0,50}?(${FORMAT_TOKEN})`,
    "i",
  );

  for (const clause of clauses) {
    const arrow = clause.match(arrowPattern);
    if (arrow) {
      const input = canonicalFormat(arrow[1]);
      const output = canonicalFormat(arrow[2]);
      if (input && output && input !== output) {
        return { input: [input], output: [output], evidence: clause, kind: "conversion" };
      }
    }

    const conversion = clause.match(conversionPattern);
    if (conversion) {
      const input = canonicalFormat(conversion[1]);
      const output = canonicalFormat(conversion[2]);
      if (input && output && input !== output) {
        return { input: [input], output: [output], evidence: clause, kind: "conversion" };
      }
    }

    // "Render invoice as PDF" often has no explicit source transport format.
    const render = clause.match(renderPattern);
    if (render) {
      const output = canonicalFormat(render[1]);
      if (output) return { input: [], output: [output], evidence: clause, kind: "result" };
    }
  }

  const resultPattern = new RegExp(`\\b${RESULT_VERB}\\b[^.;!?\\n]{0,90}`, "i");
  for (const clause of clauses) {
    const result = clause.match(resultPattern);
    if (!result) continue;
    // A URL for downloading an artifact is JSON metadata, not the artifact
    // returned by this operation (for example "returns a ZIP download URL").
    if (new RegExp(`${FORMAT_TOKEN}\\s+download\\s+url`, "i").test(result[0])) continue;
    // Likewise, a format naming the earlier request/job is context rather
    // than the response format ("outcomes for a ZIP submission").
    if (new RegExp(`${FORMAT_TOKEN}\\s+(?:submission|request|job|batch)\\b`, "i").test(result[0])) continue;
    const output = formatsIn(result[0]);
    if (output.length > 0) {
      return { input: [], output, evidence: clause, kind: "result" };
    }
  }

  const passiveResultPattern = new RegExp(
    `(${FORMAT_TOKEN})[^.;!?\\n]{0,30}\\b(?:is|are|was|were)?\\s*returned\\b|\\breturned\\b[^.;!?\\n]{0,40}?(${FORMAT_TOKEN})`,
    "i",
  );
  for (const clause of clauses) {
    const result = clause.match(passiveResultPattern);
    const output = canonicalFormat(result?.[1] ?? result?.[2] ?? "");
    if (output) return { input: [], output: [output], evidence: clause, kind: "result" };
  }
  return null;
}

/** Effective catalogue formats. Raw HTTP media types remain available to the
 * caller for the *_original provenance columns. */
export function effectiveCandidateFormats(candidate: Candidate): {
  input: string[];
  output: string[];
  inference: DeclaredFormatInference | null;
} {
  const inference = inferDeclaredFormats(candidate);
  if (!inference) {
    return { input: candidate.input_formats, output: candidate.output_formats, inference: null };
  }
  return {
    input: inference.input.length > 0 ? inference.input : candidate.input_formats,
    output: inference.output,
    inference,
  };
}
