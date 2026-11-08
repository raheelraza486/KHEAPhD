import type { ApiRecord } from "../types.ts";
import type { BusinessProcess, ProcessStep } from "./types.ts";
import type { InvoiceStandardCapability } from "./invoice-standard-capabilities.ts";
import { australianRuleSupport, requestsAustralianRules } from "./validation-rules.ts";

/** Catalogue columns used to search for a step, before schemas are loaded. */
export type CandidateApi = Pick<ApiRecord, "id" | "category" | "api_name"> & Partial<Pick<ApiRecord,
  "official_api_name" | "description" | "instructions" | "country_region" |
  "input_formats" | "output_formats" | "invoice_standard" | "business_rules" |
  "network" | "communication_direction" | "is_active" | "duplicate_of"
>> & { api_endpoint?: string | null; standard_capabilities?: readonly InvoiceStandardCapability[] };

export interface CandidateMatch {
  id: string;
  score: number;
  matched_terms: string[];
}

export interface CandidateStepResult {
  rule_review?: { id: string; status: "unverified" | "rejected" }[];
  order: number;
  source: "discovery" | "keywords" | "formats" | "none";
  matches: CandidateMatch[];
  total_matches: number;
  issue: "insufficient_task_detail" | "no_match" | "unrecognised_format" | null;
}

export interface CandidateNarrowingResult {
  process: BusinessProcess;
  steps: CandidateStepResult[];
}

const DEFAULT_LIMIT = 5;
// A named network or invoice standard is an explicit constraint, not a bonus
// that generic words such as "invoice" and "XML" may outvote.
const STANDARD_TERMS = new Set(["peppol", "xrechnung", "ksef", "zugferd", "facturx"]);
const EXTRACTION_DOCUMENT_TERMS = new Set(["invoice", "pdf", "image", "file"]);
// What an extraction operation's record must show it accepts: a document, not
// only data. A name alone ("Get Extracted Invoice Data") is not enough.
const DOCUMENT_INPUT_TERMS = new Set(["pdf", "image", "png", "jpg", "jpeg", "tif", "tiff", "multipart", "file", "base64"]);
// Words of a declared input format that name a wrapper or a media type prefix,
// not the document (application/json, multipart/form-data, octet-stream).
// Words that make a PDF a hybrid one, with the invoice XML embedded.
const HYBRID_WORDS = new Set(["hybrid", "facturx", "zugferd"]);
const DECLARED_CONTAINER_WORDS = new Set(["application", "json", "multipart", "form", "data", "url", "encoded", "urlencoded", "www", "base64", "binary", "octet", "stream", "no", "request", "body"]);
const VERSIONED_STANDARD = /\b(xrechnung|factur[\s-]*x|zug[\s-]*ferd|peppol(?:\s+bis(?:\s+billing)?)?|ksef)[\s:-]*v?(\d+(?:\.\d+)+)(?![.\d])/gi;
const STOP_WORDS = new Set([
  "a", "an", "and", "api", "by", "data", "document", "documents", "for", "from", "in",
  "into", "of", "on", "or", "our", "step", "the", "to", "using",
  "via", "with", "service", "services", "rule", "rules", "standard", "standards",
  // Connective and possessive words a user adds ("send it over Peppol", "send
  // my invoice"): no catalogue record names them, so as search terms they only
  // reject every candidate, or match an unrelated one ("my" in "MyInvois").
  "over", "through", "it", "its", "my", "your", "their", "this", "that", "then", "also",
]);
// Once a delivery network is named, it is the requirement that decides the
// candidates (the network filter); words about the recipient or the channel
// rank them but are not required to appear in a record.
const DELIVERY_WORDS = new Set(["invoice", "network", "channel", "customer", "recipient", "receiver", "buyer", "client", "copy"]);
const ACTION_WORDS: Record<string, string> = {
  convert: "convert", converting: "convert", converted: "convert", conversion: "convert", transform: "convert", transformation: "convert", map: "convert",
  extract: "extract", extracting: "extract", extracted: "extract", extraction: "extract", extractor: "extract", xtract: "extract", ocr: "extract",
  read: "extract", reading: "extract", parse: "extract", parsing: "extract", parsed: "extract", scan: "extract", scanning: "extract", scanned: "extract", capture: "extract", capturing: "extract", captured: "extract",
  generate: "generate", generating: "generate", generated: "generate", generation: "generate", create: "generate", creation: "generate", produce: "generate",
  validate: "validate", validating: "validate", validated: "validate", validation: "validate", verify: "validate", verification: "validate", check: "validate",
  send: "send", sending: "send", sent: "send", submit: "send", submitting: "send", submitted: "send", submission: "send", transmit: "send", deliver: "send", dispatch: "send", upload: "send",
  receive: "receive", receiving: "receive", received: "receive", retrieve: "receive", fetch: "receive", download: "receive", get: "receive",
};
const CHINESE_TERMS: readonly [RegExp, string][] = [
  [/\u8f6c\u6362(?:\u6210|\u4e3a|\u5230|\u81f3)/g, " convert to "],
  [/\u8f6c\u6362|\u8f6c\u5316/g, " convert "], [/\u751f\u6210|\u521b\u5efa/g, " generate "], [/\u9a8c\u8bc1|\u6821\u9a8c|\u68c0\u67e5/g, " validate "],
  [/\u63d0\u53d6|\u62bd\u53d6|\u8bc6\u522b|\u8bfb\u53d6|\u89e3\u6790|\u626b\u63cf/g, " extract "], [/\u6216\u8005|\u6216/g, " or "],
  [/\u53d1\u9001|\u63d0\u4ea4|\u4f20\u8f93/g, " send "], [/\u63a5\u6536|\u83b7\u53d6|\u4e0b\u8f7d/g, " receive "], [/\u53d1\u7968/g, " invoice "],
  [/\u90ae\u4ef6|\u90ae\u7bb1/g, " email "], [/\u6fb3\u5927\u5229\u4e9a/g, " australia "], [/\u5fb7\u56fd/g, " germany "],
];

function expandTerms(value: string): string {
  let expanded = value;
  for (const [pattern, replacement] of CHINESE_TERMS) expanded = expanded.replace(pattern, replacement);
  return expanded.replace(/\be[\s-]+mail\b/gi, "email")
    // Before "OCRModel" is split into words, so that "XRechnung" stays one.
    .replace(/\bx[\s-]*rechnung\b/gi, "xrechnung")
    .replace(/\bfactur[\s-]*x\b/gi, "facturx")
    .replace(/\bzug[\s-]*ferd\b/gi, "zugferd")
    .replace(/\bk[\s-]*sef\b/gi, "ksef")
    // "把PDF发票" is one run of letters; separate Latin words from Chinese ones.
    .replace(/(\p{Script=Han})(?=[A-Za-z0-9])|([A-Za-z0-9])(?=\p{Script=Han})/gu, "$1$2 ");
}

function words(value: string): string[] {
  return expandTerms(value).replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .normalize("NFKD").replace(/\p{M}/gu, "")
    .toLowerCase().match(/[\p{L}\p{N}]+/gu)
    ?.map((word) => {
      // "AU rules" and "AUS rules" are how the client writes "Australian rules".
      if (word === "australian" || word === "au" || word === "aus") return "australia";
      if (word === "german") return "germany";
      return word.endsWith("s") && word.length > 4 && !word.endsWith("ss") ? word.slice(0, -1) : word;
    }) ?? [];
}

function actions(tokens: readonly string[]): Set<string> {
  return new Set(tokens.map((word) => ACTION_WORDS[word]).filter((action): action is string => Boolean(action)));
}

/** Only bare delivery channels are alternatives; named invoice standards stay required. */
function deliveryAlternatives(step: ProcessStep): ProcessStep[] {
  if (step.category !== "Communication") return [step];
  // Translated first, so that "通过邮件或Peppol发送" offers both channels too.
  const task = expandTerms(step.task);
  const alternatives = /\b(e[\s-]?mail|peppol)\s+or\s+(?:(?:by|via|over|through)\s+)?(e[\s-]?mail|peppol)\b(?!\s+(?:bis\b|v?\d))/i;
  const match = task.match(alternatives);
  if (!match || words(match[1])[0] === words(match[2])[0]) return [step];
  return [match[1], match[2]].map((channel) => ({ ...step, task: task.replace(alternatives, channel) }));
}

function deliveryNetwork(step: ProcessStep, tokens: readonly string[]): string | undefined {
  if (step.category !== "Communication") return undefined;
  const named = step.task.match(/\b(?:by|via|over|through)\s+(e[\s-]?mail|peppol)\b/i);
  if (named) return words(named[1])[0];
  if (tokens.includes("email") && !tokens.includes("peppol")) return "email";
  if (tokens.includes("peppol") && !tokens.includes("email") && !/\bpeppol\s+(?:bis\b|v?\d)/i.test(step.task)) return "peppol";
  return undefined;
}

function hasPdfInput(step: ProcessStep): boolean {
  if (step.input_format?.trim()) return words(step.input_format).includes("pdf");
  const tokens = words(step.task);
  const from = tokens.indexOf("from");
  const to = tokens.findIndex((token) => token === "to" || token === "into");
  // Both "convert PDF to XML" and "convert to XML from PDF" name PDF input.
  // Merely asking for PDF output must not introduce extraction candidates.
  const input = from >= 0 ? tokens.slice(from + 1, to > from ? to : undefined)
    : tokens.slice(0, to >= 0 ? to : undefined);
  return input.includes("pdf");
}

function requestedVersions(step: ProcessStep) {
  const text = [step.task, step.rule_set, step.input_format, step.output_format].filter(Boolean).join(" ");
  return [...text.matchAll(VERSIONED_STANDARD)].map((match) => ({
    family: words(match[1])[0] === "facturx" ? "facturx" : words(match[1])[0],
    version: match[2],
  }));
}

function matchesRequestedVersions(step: ProcessStep, api: CandidateApi, wantedActions: Set<string>, claimedDirection?: "input" | "output") {
  for (const request of requestedVersions(step)) {
    const confirmed = (api.standard_capabilities ?? []).filter((row) =>
      row.status === "confirmed" && /^https?:\/\/\S+$/i.test(row.evidence_url)
      && words(row.standard).includes(request.family));
    if (confirmed.length) {
      const direction = claimedDirection ?? (step.category === "Validation" || (step.category === "Communication" && wantedActions.has("send"))
        ? "input" : wantedActions.has("generate") ? "output" : null);
      const relevant = direction ? confirmed.filter((row) => row.direction === direction) : confirmed;
      // A claim for the other side cannot say anything about this side.
      // The legacy aggregate label has no direction either, so leave this
      // candidate uncertain instead of excluding it on that evidence.
      if (!relevant.length) continue;
      if (!relevant.some((row) => row.version.replace(/^v(?=\d)/i, "") === request.version)) return false;
      continue;
    }
    const labels = (api.invoice_standard ?? []).filter((label) => words(label).includes(request.family));
    const labelledVersions = labels.flatMap((label) => [...label.matchAll(/\d+(?:\.\d+)+(?![.\d])/g)].map((match) => match[0]));
    if (labelledVersions.length && !labelledVersions.includes(request.version)) return false;
  }
  return true;
}

function searchDocument(api: CandidateApi) {
  const names = new Set(words([api.api_name, api.official_api_name ?? ""].join(" ")));
  const details = new Set(words([
    api.description ?? "", api.instructions ?? "", api.country_region ?? "", api.network ?? "",
    ...(api.input_formats ?? []), ...(api.output_formats ?? []),
    ...(api.invoice_standard ?? []), ...(api.business_rules ?? []),
  ].join(" ")));
  return { api, names, details, apiActions: actions([...names]) };
}

/** An operation's own instructions can explicitly rule out the document being
 * delivered. A positive mention of a different operation is not evidence that
 * this operation accepts it. Do not infer a rejection from names or endpoints. */
function rejectsDocumentFormat(api: CandidateApi, documentFormat: string | null): boolean {
  if (!documentFormat) return false;
  const format = documentFormat.trim();
  if (!format) return false;
  const labels = [format];
  const normalized = words(format).join(" ");
  if (normalized === "ubl xml" || normalized === "xml ubl") labels.push("UBL");
  let operationPath: string | null = null;
  try { operationPath = api.api_endpoint ? new URL(api.api_endpoint).pathname : null; } catch { /* No path to scope against. */ }
  return (api.instructions ?? "").split(/;\s*|[.!?]\s+|\n+/).some(clause => {
    const mentionedPaths = [...clause.matchAll(/(?:^|[\s(])(\/[A-Za-z0-9][A-Za-z0-9/_-]*)/g)].map(match => match[1]);
    if (mentionedPaths.length && (!operationPath || !mentionedPaths.some(path => operationPath!.toLowerCase().endsWith(path.toLowerCase())))) return false;
    return labels.some(label => {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[\\s_/-]+");
      return new RegExp(`\\b(?:not|no)\\s+(?:an?\\s+|the\\s+)?${escaped}\\b(?:\\s+(?:file|document|payload|body))?`, "i").test(clause)
        || new RegExp(`\\b(?:does\\s+not|doesn't|cannot|can't|won't)\\s+(?:accept|support|take|process|receive|send)\\s+(?:an?\\s+|the\\s+)?${escaped}\\b`, "i").test(clause);
    });
  });
}

/** Match equivalent goal wording from prose and diagram labels the same way.
 * Keep the source task intact in the returned process. Extra standards, versions
 * and qualifiers prevent this rewrite so they remain search constraints. */
function matchingGoal(step: ProcessStep, documentFormat: string | null): ProcessStep {
  const formatIs = (value: string | null | undefined, expected: readonly string[]) => {
    const actual = words(value ?? "");
    return actual.length === expected.length && expected.every(word => actual.includes(word));
  };
  const generic = (allowed: ReadonlySet<string>, action: string) => {
    const tokens = words(step.task);
    return tokens.some(word => ACTION_WORDS[word] === action)
      && tokens.every(word => allowed.has(word) || ACTION_WORDS[word] === action);
  };
  const conversionWords = new Set(["a", "an", "the", "from", "to", "into", "in", "format", "invoice", "document", "pdf", "ubl", "xml"]);
  if (step.category === "Transformation" && formatIs(step.input_format, ["pdf"])
    && formatIs(step.output_format, ["ubl", "xml"])
    && (generic(conversionWords, "convert") || generic(conversionWords, "generate"))) {
    return { ...step, task: "Convert PDF to UBL XML" };
  }
  if (step.category === "Communication" && formatIs(documentFormat, ["ubl", "xml"])
    && deliveryNetwork(step, words(step.task)) === "peppol"
    && generic(new Set(["a", "an", "the", "via", "over", "through", "by", "in", "format", "network", "invoice", "document", "ubl", "xml", "peppol"]), "send")) {
    return { ...step, task: "Send via Peppol" };
  }
  return step;
}

/** An extraction operation counts only when its record shows it takes a
 * document (PDF, image, file upload or base64) in its name, formats or text. */
function acceptsDocument({ api, names }: ReturnType<typeof searchDocument>): boolean {
  const input = words([...(api.input_formats ?? []), api.description ?? "", api.instructions ?? ""].join(" "));
  return [...names, ...input].some((word) => DOCUMENT_INPUT_TERMS.has(word));
}

/** Evidence that an API reads the PDF asked for: its name, else the document
 * formats its record declares, else its text. A record that declares other
 * document formats is not read as taking any PDF because its text mentions
 * one; and a declared Hybrid PDF (ZUGFeRD / Factur-X, as beliq and e-invoice
 * conversion read) counts only when the task asks for that kind of PDF. */
function acceptsPdf({ api, names, details }: ReturnType<typeof searchDocument>, hybridAsked: boolean): boolean {
  if (names.has("pdf")) return true;
  const declared = (api.input_formats ?? []).map((value) => words(value).filter((word) => !DECLARED_CONTAINER_WORDS.has(word)))
    .filter((entry) => entry.length);
  if (!declared.length) return details.has("pdf");
  return declared.some((entry) => entry.includes("pdf") && (hybridAsked || !entry.some((word) => HYBRID_WORDS.has(word))));
}

/** Format-based completion must keep named standards and output versions. */
export function meetsOutputConstraints(step: ProcessStep, api: CandidateApi): boolean {
  const { names, details } = searchDocument(api);
  const tokens = words([step.task, step.rule_set ?? "", step.output_format ?? ""].join(" "));
  return !tokens.some((term) => STANDARD_TERMS.has(term) && !names.has(term) && !details.has(term))
    && matchesRequestedVersions(step, api, actions(tokens), "output");
}

function scoreStep(step: ProcessStep, document: ReturnType<typeof searchDocument>, terms: readonly string[], wantedActions: Set<string>, network?: string, supportedRules = false, documentFormat: string | null = null): CandidateMatch | null {
  const { api, names, details, apiActions } = document;
  if (step.category === "Communication" && rejectsDocumentFormat(api, documentFormat)) return null;
  if (network && !(api.network?.trim() ? words(api.network).includes(network) : names.has(network) || details.has(network))) return null;
  if (terms.some((term) => STANDARD_TERMS.has(term) && !names.has(term) && !details.has(term))) return null;
  const pdfConversion = step.category === "Transformation" && wantedActions.has("convert") && hasPdfInput(step);
  const extraction = step.category === "Transformation" && apiActions.has("extract")
    && (wantedActions.has("extract") || pdfConversion) && acceptsDocument(document);
  if (!extraction && wantedActions.size && apiActions.size && ![...wantedActions].some((action) => apiActions.has(action))) return null;
  // Matching only the desired output (UBL XML) is not evidence of PDF input.
  // Extraction operations can start this conversion even when their recorded
  // formats describe an envelope (JSON/multipart) rather than the document.
  if (pdfConversion && !extraction && !acceptsPdf(document, terms.some((term) => HYBRID_WORDS.has(term)))) return null;
  if (step.category === "Communication" && wantedActions.has("send") && api.communication_direction === "Receive") return null;
  if (step.category === "Communication" && wantedActions.has("receive") && api.communication_direction === "Send") return null;
  if (!matchesRequestedVersions(step, api, wantedActions)) return null;

  let score = 0;
  const matched_terms: string[] = [];
  for (const term of terms) {
    if (names.has(term)) { score += 3; matched_terms.push(term); }
    else if (details.has(term)) { score += 1; matched_terms.push(term); }
  }
  // An invoice is the attachment, not a capability a general email sender must advertise.
  // A named extraction operation is relevant even with sparse format metadata.
  // Do not require it to produce UBL XML itself: a later Transformation may
  // still be needed (#89). Unrelated terms and hard constraints are retained.
  let requiredTerms = extraction
    ? terms.filter((term) => !EXTRACTION_DOCUMENT_TERMS.has(term) && term !== "ubl" && term !== "xml")
    : network ? terms.filter((term) => !DELIVERY_WORDS.has(term)) : terms;
  if (supportedRules) {
    const formatTerms = new Set(words([step.input_format, step.output_format].filter(Boolean).join(" ")));
    requiredTerms = requiredTerms.filter(term => term !== "australia" && !formatTerms.has(term));
  }
  if (requiredTerms.filter((term) => matched_terms.includes(term)).length < Math.ceil(requiredTerms.length * 0.6)) return null;
  // A sending record shows it sends in its name ("Send Message") or, when the
  // name says how ("Import Invoice"), in its declared communication direction.
  const sendsByDirection = step.category === "Communication" && wantedActions.has("send")
    && /\bsend\b/i.test(api.communication_direction ?? "");
  if (extraction || sendsByDirection || [...wantedActions].some((action) => apiActions.has(action))) score += 4;
  return { id: api.id, score, matched_terms };
}

/** Resolve every step to real catalogue IDs before composeChains. */
export function narrowProcessCandidates(
  process: BusinessProcess,
  catalogue: readonly CandidateApi[],
  options: { maxKeywordCandidates?: number } = {},
): CandidateNarrowingResult {
  const limit = options.maxKeywordCandidates ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("maxKeywordCandidates must be a positive integer");
  const steps: CandidateStepResult[] = [];
  const searchable = catalogue.filter((api) => api.is_active !== false && !api.duplicate_of).map(searchDocument);
  const narrowed = process.steps.map((step, index) => {
    const eligible = searchable.filter(({ api }) => api.category === step.category);
    const ids = new Set(eligible.map(({ api }) => api.id));
    let matches: CandidateMatch[] = [];
    let source: CandidateStepResult["source"] = "none";
    let issue: CandidateStepResult["issue"] = null;
    let total = 0;
    const australian = requestsAustralianRules(step);
    // The latest declared output is the document handed to a sending step.
    // Use it only to check the selected operation; do not fill an unspecified
    // input_format on the user's requirement.
    const documentFormat = step.category === "Communication" ? step.input_format
      ?? process.steps.slice(0, index).reverse().find(prior => prior.category === "Transformation" && prior.output_format)?.output_format ?? null : null;
    const ruleReview = new Map<string, "unverified" | "rejected">();

    if (step.candidate_ids != null) {
      source = "discovery";
      if (australian) for (const id of step.candidate_ids) {
        const api = eligible.find(entry => entry.api.id === id)?.api;
        if (api) { const status = australianRuleSupport(api); if (status !== "supported") ruleReview.set(id, status); }
      }
      matches = [...new Set(step.candidate_ids)].filter((id) => ids.has(id)
        && !rejectsDocumentFormat(eligible.find(entry => entry.api.id === id)!.api, documentFormat)
        && (!australian || australianRuleSupport(eligible.find(entry => entry.api.id === id)!.api) === "supported"))
        .map((id) => ({ id, score: 0, matched_terms: [] }));
      total = matches.length;
      if (!total) issue = "no_match";
    } else {
      const queries = deliveryAlternatives(matchingGoal(step, documentFormat)).map((query) => {
        // A sender delivers the document it is given. The input format of a
        // Communication step names that document (Discovery often carries it
        // over from the step before); whether a sender accepts it is for the
        // compatibility checks, not a word its record must contain.
        const inputFormat = query.category === "Communication" ? "" : query.input_format ?? "";
        const tokens = words([query.task, inputFormat, query.output_format ?? "", query.rule_set ?? ""].join(" "));
        // Untranslated connective words cannot match English catalogue descriptions.
        const terms = [...new Set(tokens.filter((word) =>
          !STOP_WORDS.has(word) && !ACTION_WORDS[word] && word.length > 1 && !/\p{Script=Han}/u.test(word)))];
        return { step: query, terms, wantedActions: actions(tokens), network: deliveryNetwork(query, tokens) };
      });
      if (queries.every(({ terms }) => !terms.length || (terms.length === 1 && terms[0] === "invoice"))) issue = "insufficient_task_detail";
      else {
        source = "keywords";
        const ranked = eligible.flatMap((document) => {
          const support = australian ? australianRuleSupport(document.api) : "supported";
          if (support !== "supported") {
            // Review-only records never become candidate IDs or checked chains.
            const relevant = queries.some(query => scoreStep(query.step, document, query.terms.filter(term => term !== "australia"), query.wantedActions, query.network, false, documentFormat));
            if (relevant) ruleReview.set(document.api.id, support);
            return [];
          }
          const queryMatches = queries.map((query) => scoreStep(query.step, document, query.terms, query.wantedActions, query.network, australian, documentFormat));
          const match = queryMatches.filter((value): value is CandidateMatch => value !== null)
            .sort((a, b) => b.score - a.score)[0];
          return match ? [{ api: document.api, match, queryMatches }] : [];
        })
          .sort((a, b) => b.match.score - a.match.score || a.api.api_name.localeCompare(b.api.api_name) || a.api.id.localeCompare(b.api.id));
        total = ranked.length;
        // Keep a candidate for each alternative when the cap permits it.
        const selected = new Set<string>();
        if (queries.length > 1 && limit >= queries.length) {
          for (let index = 0; index < queries.length; index++) {
            const first = ranked.find((entry) => entry.queryMatches[index]);
            if (first) selected.add(first.api.id);
          }
        }
        for (const { api } of ranked) {
          if (selected.size >= limit) break;
          selected.add(api.id);
        }
        matches = ranked.filter(({ api }) => selected.has(api.id)).map(({ match }) => match);
        if (!total) issue = "no_match";
      }
    }
    steps.push({ order: step.order, source, matches, total_matches: total, issue,
      ...(ruleReview.size ? { rule_review: [...ruleReview].sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([id, status]) => ({ id, status })) } : {}),
    });
    return { ...step, candidate_ids: matches.map(({ id }) => id) };
  });
  return { process: { steps: narrowed }, steps };
}
