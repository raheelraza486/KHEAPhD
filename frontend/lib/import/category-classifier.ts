// Conservative, deterministic classification for a single OpenAPI operation.
//
// The catalogue categories describe an operation's business capability, not
// its HTTP verb. We therefore use only facts explicitly present on that
// operation. A weak or contradictory signal deliberately returns Other; a
// human can classify it later through the catalogue edit workflow.

import type {
  ApiCategory,
  ApiCommunicationDirection,
  CommunicationDirection,
} from "../types.ts";
import type { Candidate } from "./types.ts";

type ClassifiedCategory = Exclude<ApiCategory, "Other">;
type SignalSource = "tag" | "operation" | "path" | "description" | "structure";
type DirectionSource = Exclude<SignalSource, "structure">;
type OneWayDirection = Extract<CommunicationDirection, "Send" | "Receive">;

export type CategoryEvidence = {
  category: ClassifiedCategory;
  source: SignalSource;
  signal: string;
  score: number;
};

export type CategoryClassification = {
  category: ApiCategory;
  communication_direction: ApiCommunicationDirection;
  confidence: "high" | "low";
  evidence: CategoryEvidence[];
};

const CATEGORIES: readonly ClassifiedCategory[] = [
  "Communication",
  "Transformation",
  "Validation",
];

/** Make operationIds such as validateInvoice searchable without translating
 * or otherwise interpreting the document text. */
function searchable(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[łŁ]/g, "l")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase();
}

const CATEGORY_TERMS: Record<ClassifiedCategory, RegExp> = {
  Communication: /\b(?:communication|communicat(?:e|es|ed|ing)|transmission|transmit(?:s|ted|ting)?|delivery|deliver(?:s|ed|ing)?|dispatch(?:es|ed|ing)?|send(?:s|ing)?|sent|receiv(?:e|es|ed|ing)|messag(?:e|es|ing)|notification|notif(?:y|ies|ied|ying)|webhooks?|exchange(?:s|d|ing)?|inbound|outbound|incoming|outgoing|wysylka|wyslanie|przeslanie|pobranie|odbior)\b/i,
  Transformation: /\b(?:transformation|transform(?:s|ed|ing)?|conversion|convert(?:s|ed|ing)?|translation|translate(?:s|d|ing)?|mapping|map(?:s|ped|ping)?|normalization|normalisation|normalize(?:s|d|ing)?|normalise(?:s|d|ing)?|canonicalization|canonicalisation|canonicalize(?:s|d|ing)?|canonicalise(?:s|d|ing)?|serializ(?:e|es|ed|ing|ation)|deserializ(?:e|es|ed|ing|ation)|konwersja|przeksztalcenie|mapowanie)\b/i,
  Validation: /\b(?:validation|validat(?:e|es|ed|ing|or)|conformance|conformity|compliance|lint(?:s|ed|ing)?|walidacja|weryfikacja|sprawdzenie|zgodnosc)\b/i,
};

const DIRECTION_OBJECT = "(?:e[ -]?invoices?|invoices?|documents?|files?|messages?|payloads?|transactions?|business data|credit notes?)";
const SEND_VERB = "(?:send|sends|sent|sending|submit|submits|submitted|submitting|upload|uploads|uploaded|uploading|publish|publishes|published|publishing|transmit|transmits|transmitted|transmitting|dispatch|dispatches|dispatched|dispatching|deliver|delivers|delivered|delivering)";
const RECEIVE_VERB = "(?:receive|receives|received|receiving|retrieve|retrieves|retrieved|retrieving|fetch|fetches|fetched|fetching|download|downloads|downloaded|downloading|query|queries|queried|querying|get|gets|list|lists)";

// Direction is from the API caller's documented business perspective. These
// patterns require an explicit direction word (or a directional business
// term); the HTTP method is deliberately absent because POST may create,
// validate or send and GET may retrieve status rather than receive an invoice.
const DIRECTION_TERMS: Record<OneWayDirection, RegExp[]> = {
  Send: [
    new RegExp(`\\b${SEND_VERB}\\b.{0,32}\\b${DIRECTION_OBJECT}\\b|\\b${DIRECTION_OBJECT}\\b.{0,32}\\b${SEND_VERB}\\b`, "i"),
    /\b(?:outbound|outgoing|submission|dispatch|wysylka|wyslanie|przeslanie)\b/i,
    /^(?:send|sending|submit|submission|upload|outbound|outgoing)$/i,
  ],
  Receive: [
    new RegExp(`\\b${RECEIVE_VERB}\\b.{0,32}\\b${DIRECTION_OBJECT}\\b|\\b${DIRECTION_OBJECT}\\b.{0,32}\\b${RECEIVE_VERB}\\b`, "i"),
    /\b(?:inbound|incoming|retrieval|pobranie|odbior)\b/i,
    /^(?:receive|receiving|retrieve|retrieval|download|inbound|incoming)$/i,
  ],
};

type DirectionEvidence = {
  direction: OneWayDirection;
  source: DirectionSource;
  score: number;
};

function matchingDirections(value: string): OneWayDirection[] {
  const normalized = searchable(value);
  if (!normalized) return [];
  return (["Send", "Receive"] as const).filter((direction) =>
    DIRECTION_TERMS[direction].some((pattern) => pattern.test(normalized))
  );
}

function addDirectionEvidence(
  evidence: DirectionEvidence[],
  source: DirectionSource,
  value: string,
  score: number,
) {
  for (const direction of matchingDirections(value)) {
    evidence.push({ direction, source, score });
  }
}

/**
 * Resolve the Communication subcategory conservatively. Description text can
 * support a direction stated in primary OpenAPI metadata, but can never create
 * a direction by itself. Two-way is returned only when the same primary field,
 * or explicit direction-bearing tags, state both directions.
 */
function classifyCommunicationDirection(candidate: Candidate): CommunicationDirection {
  const primary: DirectionEvidence[] = [];
  const tagDirectionSets: OneWayDirection[][] = [];
  for (const tag of candidate.operation_tags ?? []) {
    const directions = matchingDirections(tag);
    tagDirectionSets.push(directions);
    for (const direction of directions) {
      primary.push({ direction, source: "tag", score: 10 });
    }
  }

  const operationId = candidate.operation_id ?? "";
  const operationSummary = candidate.operation_summary ?? candidate.official_api_name;
  const operationPath = candidate.operation_path ?? "";
  const primaryTexts: { source: DirectionSource; value: string; score: number }[] = [
    { source: "operation", value: operationId, score: 6 },
    { source: "operation", value: operationSummary, score: 6 },
    { source: "path", value: operationPath, score: 5 },
  ];
  for (const item of primaryTexts) {
    addDirectionEvidence(primary, item.source, item.value, item.score);
  }

  if (primary.length === 0) {
    // As with category inference, an operation may put the action in its label
    // and the business object in its path.
    addDirectionEvidence(
      primary,
      "operation",
      [operationId, operationSummary, operationPath].filter(Boolean).join(" "),
      5,
    );
  }

  // A direction mentioned only in a description is deliberately insufficient.
  if (primary.length === 0) return "Unspecified";

  const explicitTwoWay = primaryTexts.some(
    ({ value }) => matchingDirections(value).length === 2,
  ) || tagDirectionSets.some((directions) => directions.length === 2)
    || new Set(tagDirectionSets.flat()).size === 2;
  if (explicitTwoWay) return "Send and receive";

  const evidence = [...primary];
  addDirectionEvidence(evidence, "description", candidate.description, 2);
  const primaryDirections = new Set(primary.map((item) => item.direction));
  if (primaryDirections.size === 1) return [...primaryDirections][0];

  const sendScore = evidence
    .filter((item) => item.direction === "Send")
    .reduce((total, item) => total + item.score, 0);
  const receiveScore = evidence
    .filter((item) => item.direction === "Receive")
    .reduce((total, item) => total + item.score, 0);
  if (sendScore - receiveScore >= 3) return "Send";
  if (receiveScore - sendScore >= 3) return "Receive";
  return "Unspecified";
}

function classification(
  category: ApiCategory,
  confidence: CategoryClassification["confidence"],
  evidence: CategoryEvidence[],
  direction: CommunicationDirection,
): CategoryClassification {
  return {
    category,
    communication_direction: category === "Communication" ? direction : "",
    confidence,
    evidence,
  };
}

// These verbs only become useful when their object makes the intent explicit.
const CONTEXTUAL_TERMS: Record<ClassifiedCategory, RegExp> = {
  Communication: /\b(?:send|sends|sent|sending|receive|receives|received|receiving|submit|submits|submitted|submitting|upload|uploads|uploaded|uploading|download|downloads|downloaded|downloading|publish|publishes|published|publishing|retrieve|retrieves|retrieved|retrieving|fetch|fetches|fetched|fetching|query|queries|queried|querying|get|gets|list|lists)\b.{0,32}\b(?:invoice|document|file|message|payload|transaction|business data)\b|\b(?:invoice|document|file|message|payload|transaction|business data)\b.{0,32}\b(?:send|sends|sent|sending|receive|receives|received|receiving|submit|submits|submitted|submitting|upload|uploads|uploaded|uploading|download|downloads|downloaded|downloading|publish|publishes|published|publishing|retrieve|retrieves|retrieved|retrieving|fetch|fetches|fetched|fetching|query|queries|queried|querying|get|gets|list|lists)\b/i,
  Transformation: /\b(?:render|renders|rendered|rendering|format|formats|formatted|formatting|create|creates|created|creating|creation|generate|generates|generated|generating|generation|issue|issues|issued|issuing|issuance)\b.{0,32}\b(?:invoice|document|file|payload|data)\b|\b(?:invoice|document|file|payload|data)\b.{0,32}\b(?:render|renders|rendered|rendering|format|formats|formatted|formatting|create|creates|created|creating|creation|generate|generates|generated|generating|generation|issue|issues|issued|issuing|issuance)\b/i,
  Validation: /\b(?:check|checks|checked|checking|verify|verifies|verified|verifying)\b.{0,32}\b(?:invoice|document|payload|schema|syntax|business rule|compliance|conformance)\b|\b(?:invoice|document|payload|schema|syntax|business rule|compliance|conformance)\b.{0,32}\b(?:check|verify)(?:s|ied|ing)?\b/i,
};

function matchingCategories(value: string): ClassifiedCategory[] {
  const normalized = searchable(value);
  if (!normalized) return [];
  return CATEGORIES.filter((category) =>
    CATEGORY_TERMS[category].test(normalized) || CONTEXTUAL_TERMS[category].test(normalized)
  );
}

function addTextEvidence(
  evidence: CategoryEvidence[],
  source: Exclude<SignalSource, "structure">,
  value: string,
  score: number,
) {
  for (const category of matchingCategories(value)) {
    evidence.push({ category, source, signal: value, score });
  }
}

function mediaType(value: string): string {
  return value.split(";", 1)[0].trim().toLowerCase();
}

/** Different declared request and response media types are a structural
 * transformation signal only when the two sets do not overlap. */
function declaresFormatConversion(candidate: Candidate): boolean {
  const inputs = new Set(candidate.input_formats.map(mediaType).filter(Boolean));
  const outputs = new Set(candidate.output_formats.map(mediaType).filter(Boolean));
  if (inputs.size === 0 || outputs.size === 0) return false;
  return [...inputs].every((format) => !outputs.has(format));
}

/** Infer one of the three controlled capability categories. The evidence is
 * returned for tests and future preview explanations, but only category is
 * persisted. */
export function classifyOpenApiCandidate(candidate: Candidate): CategoryClassification {
  const communicationDirection = classifyCommunicationDirection(candidate);
  const tagEvidence: CategoryEvidence[] = [];
  for (const tag of candidate.operation_tags ?? []) {
    addTextEvidence(tagEvidence, "tag", tag, 10);
  }

  // A category-bearing OpenAPI tag is the author's clearest classification.
  // Conflicting tags are not resolved by guessing from weaker text.
  const taggedCategories = new Set(tagEvidence.map((item) => item.category));
  if (taggedCategories.size === 1) {
    return classification(
      [...taggedCategories][0],
      "high",
      tagEvidence,
      communicationDirection,
    );
  }
  if (taggedCategories.size > 1) {
    return classification("Other", "low", tagEvidence, communicationDirection);
  }

  const evidence: CategoryEvidence[] = [];
  const operationId = candidate.operation_id ?? "";
  const operationSummary = candidate.operation_summary ?? candidate.official_api_name;
  const operationPath = candidate.operation_path ?? "";
  addTextEvidence(evidence, "operation", operationId, 6);
  addTextEvidence(evidence, "operation", operationSummary, 6);
  addTextEvidence(evidence, "path", operationPath, 5);
  if (evidence.length === 0) {
    // Some specifications split the verb and its business object between the
    // summary and path (for example "Generate IRN" on `/Invoice`). Treat the
    // combined operation text as one primary signal without letting it
    // multiply evidence that was already clear on its own.
    addTextEvidence(
      evidence,
      "operation",
      [operationId, operationSummary, operationPath].filter(Boolean).join(" "),
      5,
    );
  }

  // Description is supporting evidence. On its own it is intentionally below
  // the decision threshold because descriptions often mention validation or
  // delivery only as an error, prerequisite or later step.
  addTextEvidence(evidence, "description", candidate.description, 2);

  if (candidate.has_callbacks) {
    evidence.push({
      category: "Communication",
      source: "structure",
      signal: "OpenAPI callbacks",
      // A callback may only report internal job status, so it supports an
      // explicit communication description but cannot classify by itself.
      score: 3,
    });
  }
  if (declaresFormatConversion(candidate)) {
    evidence.push({
      category: "Transformation",
      source: "structure",
      signal: "non-overlapping request/response media types",
      // Different media types can also describe an ordinary request and
      // response (for example XML authentication returning JSON), so this is
      // supporting evidence rather than a decision on its own.
      score: 3,
    });
  }

  const totals = new Map<ClassifiedCategory, number>(CATEGORIES.map((category) => [category, 0]));
  for (const item of evidence) {
    totals.set(item.category, (totals.get(item.category) ?? 0) + item.score);
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const [bestCategory, bestScore] = ranked[0];
  const secondScore = ranked[1]?.[1] ?? 0;

  // One strong primary-text signal (>= 5), or aligned weak text plus
  // structure, is enough, but it must beat the next category by a full
  // supporting-description signal plus one.
  if (bestScore >= 5 && bestScore - secondScore >= 3) {
    return classification(
      bestCategory,
      "high",
      evidence.filter((item) => item.category === bestCategory),
      communicationDirection,
    );
  }
  return classification("Other", "low", evidence, communicationDirection);
}
