import type { ApiRecord } from "./types.ts";
import { formatFormatsForDisplay, formatInputFormatsForDisplay, isNoRequestBodyFormat } from "./format-display.ts";

const sentences = new Intl.Segmenter("en", { granularity: "sentence" });

/** Summarise recorded text without inventing capabilities, parameters or requirements. */
export function catalogCardSummary(record: ApiRecord) {
  const description = record.description.trim();
  const firstSentence = sentences.segment(description)[Symbol.iterator]().next().value?.segment.trim() ?? "";
  const usePurposeAsTitle = firstSentence.length > 0 && firstSentence.length <= 110;
  const parameters = [...new Set([...record.api_endpoint.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]))];
  const formats = record.input_formats.map((value) => value.trim()).filter(Boolean);
  const noBody = formats.length > 0 && formats.every((value) => isNoRequestBodyFormat(value) || value.toLowerCase() === "no request body");
  const urlInput = parameters.length === 1 && parameters[0].toLowerCase() === "id"
    ? "ID in the URL" : parameters.length ? `URL values: ${parameters.join(", ")}` : "";
  const input = noBody
    ? urlInput ? `${urlInput}; no request body` : "No request body; check parameter details"
    : `${formatInputFormatsForDisplay(record.input_formats, "Input details not recorded")}${urlInput ? `; ${urlInput}` : ""}`;
  const rules = record.business_rules.map((rule) => rule.trim()).filter(Boolean);
  return {
    title: usePurposeAsTitle ? firstSentence.replace(/[.!?]$/, "") : record.api_name,
    description: usePurposeAsTitle ? "" : description,
    input,
    output: formatFormatsForDisplay(record.output_formats, "Response details not recorded"),
    rules: rules.slice(0, 2),
    moreRules: Math.max(0, rules.length - 2),
  };
}
