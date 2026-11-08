/**
 * The JSON the Discovery / LLM stream hands to the BP-Builder: a business
 * process in the user's words, split into at most four steps.
 *
 *   {
 *     "version": "1.0",
 *     "input_text": "convert PDF to UBL XML, validate with Australian rules and send by email",
 *     "steps": [
 *       { "order": 1, "category": "Transformation", "task": "convert PDF to UBL XML",
 *         "input_format": "PDF", "output_format": "UBL XML", "rule_set": null, "candidate_ids": null },
 *       ...
 *     ],
 *     "unmatched": []
 *   }
 *
 * Each step is a ProcessStep. Candidate IDs are resolved against the catalogue
 * by narrowProcessCandidates before composeChains runs. The format is strict:
 * an unknown or misspelt field is an error rather than ignored, so a change
 * is a new version, not a drift.
 *
 * This checks the shape. Whether the process itself is acceptable (at most
 * four steps, Transformation → Validation → Communication) is planProcess's
 * question, answered with the same messages whoever built the process.
 *
 * PROCESS_JSON_SCHEMA is the same contract as a JSON Schema, and is kept
 * identical to process-format.schema.json, the copy the LLM stream can give its
 * model as a response schema.
 */
import { STEP_CATEGORIES, type BusinessProcess, type ProcessStep } from "./types.ts";

export const PROCESS_FORMAT_VERSION = "1.0";

const STEP_KEYS = ["order", "category", "task", "input_format", "output_format", "rule_set", "candidate_ids"] as const;
const TOP_KEYS = ["version", "input_text", "steps", "unmatched"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_INPUT_TEXT = 2000;
const MAX_TASK = 300;
const MAX_NAME = 100;

export const PROCESS_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Business process for the BP-Builder",
  type: "object",
  additionalProperties: false,
  required: [...TOP_KEYS],
  properties: {
    version: { const: PROCESS_FORMAT_VERSION },
    input_text: { type: "string", minLength: 1, maxLength: MAX_INPUT_TEXT, description: "The user's text, unchanged." },
    steps: {
      type: "array",
      description: "The steps in the order the user described them. Order numbers run 1, 2, 3.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["order", "category", "task"],
        properties: {
          order: { type: "integer", minimum: 1 },
          category: { enum: [...STEP_CATEGORIES] },
          task: { type: "string", minLength: 1, maxLength: MAX_TASK, description: "What the step does, in the user's words." },
          input_format: { type: ["string", "null"], minLength: 1, maxLength: MAX_NAME, description: "A format the user named for the step's input, e.g. PDF." },
          output_format: { type: ["string", "null"], minLength: 1, maxLength: MAX_NAME, description: "A format the user named for the step's output, e.g. UBL XML." },
          rule_set: { type: ["string", "null"], minLength: 1, maxLength: MAX_NAME, description: "A rule set the user named, e.g. Australian rules." },
          candidate_ids: {
            type: ["array", "null"],
            uniqueItems: true,
            items: { type: "string", format: "uuid" },
            description: "Repository API ids (apis.id) suited to the task, from Discovery when available. Null: search the catalogue after parsing. Never invented by the model.",
          },
        },
      },
    },
    unmatched: {
      type: "array",
      items: { type: "string", minLength: 1 },
      description: "Parts of the text that are not a Transformation, Validation or Communication step.",
    },
  },
} as const;

export interface FormatError {
  /** Where in the JSON, e.g. "steps[1].category". */
  path: string;
  message: string;
}

export type ParsedProcess =
  | { ok: true; input_text: string; unmatched: string[]; process: BusinessProcess }
  | { ok: false; errors: FormatError[] };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[], at: string, errors: FormatError[]) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push({ path: at ? `${at}.${key}` : key, message: `Unknown field "${key}"; the fields are ${allowed.join(", ")}.` });
  }
}

function text(value: unknown, path: string, max: number, errors: FormatError[]): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push({ path, message: "Must be a non-empty string." });
    return null;
  }
  if (value.length > max) {
    errors.push({ path, message: `Must be at most ${max} characters.` });
    return null;
  }
  return value.trim();
}

function optionalName(value: unknown, path: string, errors: FormatError[]): string | null {
  if (value === undefined || value === null) return null;
  return text(value, path, MAX_NAME, errors);
}

function step(value: unknown, index: number, errors: FormatError[]): ProcessStep | null {
  const at = `steps[${index}]`;
  if (!isObject(value)) {
    errors.push({ path: at, message: "Must be an object." });
    return null;
  }
  const before = errors.length;
  unknownKeys(value, STEP_KEYS, at, errors);

  if (value.order !== index + 1) {
    errors.push({ path: `${at}.order`, message: `Must be ${index + 1}: steps are listed in order and numbered from 1.` });
  }
  const category = value.category;
  if (typeof category !== "string" || !(STEP_CATEGORIES as readonly string[]).includes(category)) {
    errors.push({ path: `${at}.category`, message: `Must be exactly one of ${STEP_CATEGORIES.join(", ")}.` });
  }
  const task = text(value.task, `${at}.task`, MAX_TASK, errors);
  const input_format = optionalName(value.input_format, `${at}.input_format`, errors);
  const output_format = optionalName(value.output_format, `${at}.output_format`, errors);
  const rule_set = optionalName(value.rule_set, `${at}.rule_set`, errors);

  let candidate_ids: string[] | null = null;
  if (value.candidate_ids !== undefined && value.candidate_ids !== null) {
    const ids = value.candidate_ids;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !UUID.test(id))) {
      errors.push({ path: `${at}.candidate_ids`, message: "Must be null or a list of repository API ids (UUIDs)." });
    } else if (new Set(ids).size !== ids.length) {
      errors.push({ path: `${at}.candidate_ids`, message: "Lists an API more than once." });
    } else {
      candidate_ids = ids as string[];
    }
  }

  if (errors.length > before) return null;
  return {
    order: index + 1,
    category: category as ProcessStep["category"],
    task: task!,
    input_format,
    output_format,
    rule_set,
    candidate_ids,
  };
}

/** Check the JSON (already parsed) and return the process for composeChains. */
export function parseProcessJson(value: unknown): ParsedProcess {
  const errors: FormatError[] = [];
  if (!isObject(value)) return { ok: false, errors: [{ path: "", message: "Must be a JSON object." }] };
  unknownKeys(value, TOP_KEYS, "", errors);

  if (value.version !== PROCESS_FORMAT_VERSION) {
    errors.push({ path: "version", message: `Must be "${PROCESS_FORMAT_VERSION}".` });
  }
  const input_text = text(value.input_text, "input_text", MAX_INPUT_TEXT, errors);

  const steps: ProcessStep[] = [];
  if (!Array.isArray(value.steps)) {
    errors.push({ path: "steps", message: "Must be a list; an empty list when no step was recognised." });
  } else {
    value.steps.forEach((s, i) => {
      const parsed = step(s, i, errors);
      if (parsed) steps.push(parsed);
    });
  }

  const unmatched: string[] = [];
  if (!Array.isArray(value.unmatched)) {
    errors.push({ path: "unmatched", message: "Must be a list; an empty list when everything was matched." });
  } else {
    value.unmatched.forEach((u, i) => {
      const t = text(u, `unmatched[${i}]`, MAX_INPUT_TEXT, errors);
      if (t) unmatched.push(t);
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, input_text: input_text!, unmatched, process: { steps } };
}
