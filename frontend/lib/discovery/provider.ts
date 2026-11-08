import { DISCOVERY_RESPONSE_SCHEMA, DISCOVERY_SYSTEM_INSTRUCTION, discoveryPrompt } from "./prompt.ts";
import { normalizeDiscoveryResult } from "./normalize.ts";
import { groundDiscoveryResult, type DiscoveryReview } from "./grounding.ts";
import type { DiscoveryInput } from "./types.ts";
import { bounded, configuredMs } from '../workspace/execution.ts';

export const DEFAULT_DISCOVERY_MODEL = "gemini-3.5-flash-lite";
const DEFAULT_TIMEOUT_MS = 30_000;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class DiscoveryConfigurationError extends Error {
  constructor(message = "Discovery is not configured.") {
    super(message);
    this.name = "DiscoveryConfigurationError";
  }
}

export type DiscoveryProviderErrorCode = "timeout" | "temporarily_unavailable" | "rejected" | "invalid_response";

export class DiscoveryProviderError extends Error {
  readonly code: DiscoveryProviderErrorCode;
  readonly retryAfter?: string;

  constructor(
    code: DiscoveryProviderErrorCode,
    message: string,
    retryAfter?: string,
  ) {
    super(message);
    this.name = "DiscoveryProviderError";
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export interface DiscoveryProviderOptions {
  onReview?: (notes: DiscoveryReview[]) => void;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}

function responseText(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const candidates = (value as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return null;
  const parts = candidates
    .flatMap((candidate) => {
      if (typeof candidate !== "object" || candidate === null) return [];
      const content = (candidate as { content?: unknown }).content;
      if (typeof content !== "object" || content === null) return [];
      const valueParts = (content as { parts?: unknown }).parts;
      return Array.isArray(valueParts) ? valueParts : [];
    })
    .map((part) => typeof part === "object" && part !== null ? (part as { text?: unknown }).text : undefined)
    .filter((part): part is string => typeof part === "string");
  return parts.length > 0 ? parts.join("") : null;
}

function jsonText(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced ? fenced[1] : trimmed;
}

async function parts(input: DiscoveryInput): Promise<Record<string, unknown>[]> {
  const result: Record<string, unknown>[] = [{ text: discoveryPrompt(input) }];
  if (input.mode === "text") return result;
  if (input.mode === "bpmn" && input.bpmn_xml) {
    result.push({ text: `<untrusted-bpmn-xml>\n${input.bpmn_xml}\n</untrusted-bpmn-xml>` });
    return result;
  }
  const data = Buffer.from(await input.file.arrayBuffer()).toString("base64");
  result.push({ inline_data: { mime_type: input.file.type, data } });
  return result;
}

/** Call Gemini with a strict response schema. Repository data is never sent to the model. */
export async function discoverProcess(input: DiscoveryInput, options: DiscoveryProviderOptions = {}): Promise<unknown> {
  const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey) throw new DiscoveryConfigurationError();
  const model = (options.model ?? process.env.DISCOVERY_MODEL ?? DEFAULT_DISCOVERY_MODEL).trim();
  if (!model) throw new DiscoveryConfigurationError("DISCOVERY_MODEL is empty.");
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(options.timeoutMs ?? configuredMs('DISCOVERY_MODEL_TIMEOUT_MS', DEFAULT_TIMEOUT_MS))]);

  try {
    const response = await bounded(fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: DISCOVERY_SYSTEM_INSTRUCTION }] },
          contents: [{ role: "user", parts: await bounded(parts(input), signal) }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 4_096,
            responseFormat: {
              text: { mimeType: "APPLICATION_JSON", schema: DISCOVERY_RESPONSE_SCHEMA },
            },
          },
        }),
        signal,
      },
    ), signal);

    if (!response.ok) {
      const retryAfter = response.headers.get("retry-after") ?? undefined;
      if (response.status === 402 || response.status === 429 || response.status >= 500) {
        throw new DiscoveryProviderError("temporarily_unavailable", "The model service is temporarily unavailable.", retryAfter);
      }
      throw new DiscoveryProviderError("rejected", "The model service rejected the request.");
    }

    let body: unknown;
    try {
      body = await bounded(response.json(), signal);
    } catch {
      if (signal.aborted) throw new DiscoveryProviderError("timeout", "The model response timed out.");
      throw new DiscoveryProviderError("invalid_response", "The model returned an unreadable response.");
    }
    const generated = responseText(body);
    if (!generated) throw new DiscoveryProviderError("invalid_response", "The model returned no structured result.");
    try {
      const grounded = groundDiscoveryResult(JSON.parse(jsonText(generated)), input);
      options.onReview?.(grounded.review);
      return normalizeDiscoveryResult(grounded.process);
    } catch {
      throw new DiscoveryProviderError("invalid_response", "The model returned invalid JSON.");
    }
  } catch (error) {
    if (signal.aborted) throw new DiscoveryProviderError('timeout', 'The model request timed out or was cancelled.');
    if (error instanceof DiscoveryProviderError) throw error;
    throw new DiscoveryProviderError('temporarily_unavailable', 'The model service could not be reached.');
  }
}
