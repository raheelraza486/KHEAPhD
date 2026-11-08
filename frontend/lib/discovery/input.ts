import { DISCOVERY_MODES, type DiscoveryInput, type DiscoveryMode, type DiscoveryUpload } from "./types.ts";
import { BpmnXmlError, hasBpmnExtension, MAX_BPMN_XML_BYTES, readBpmnXml } from "./bpmn.ts";

export const MAX_DISCOVERY_TEXT_CHARS = 2_000;
export const MAX_BPMN_BYTES = 5 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_MULTIPART_BYTES = MAX_AUDIO_BYTES + 1024 * 1024;

export { MAX_BPMN_XML_BYTES };

const BPMN_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const AUDIO_MIME_TYPES = new Set([
  "audio/aac",
  "audio/flac",
  "audio/mp3",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/x-aac",
  "audio/x-flac",
  "audio/x-m4a",
  "audio/x-wav",
]);

export class DiscoveryInputError extends Error {
  readonly status: 400 | 413 | 415;

  constructor(message: string, status: 400 | 413 | 415) {
    super(message);
    this.name = "DiscoveryInputError";
    this.status = status;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUpload(value: FormDataEntryValue | null): value is FormDataEntryValue & DiscoveryUpload {
  if (typeof value !== "object" || value === null) return false;
  const upload = value as unknown as Partial<DiscoveryUpload>;
  return typeof upload.name === "string"
    && typeof upload.type === "string"
    && typeof upload.size === "number"
    && typeof upload.arrayBuffer === "function";
}

function mode(value: unknown): DiscoveryMode {
  if (typeof value !== "string" || !(DISCOVERY_MODES as readonly string[]).includes(value)) {
    throw new DiscoveryInputError(`mode must be one of ${DISCOVERY_MODES.join(", ")}.`, 400);
  }
  return value as DiscoveryMode;
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DiscoveryInputError("text must be a non-empty string.", 400);
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_DISCOVERY_TEXT_CHARS) {
    throw new DiscoveryInputError(`text must be at most ${MAX_DISCOVERY_TEXT_CHARS} characters.`, 413);
  }
  return trimmed;
}

function cleanFileName(name: string): string {
  return name.split(/[\\/]/).at(-1)?.slice(0, 180) || "upload";
}

async function bpmnXmlInput(value: FormDataEntryValue & DiscoveryUpload): Promise<DiscoveryInput> {
  let cleaned: string;
  try {
    cleaned = await readBpmnXml(value);
  } catch (error) {
    if (error instanceof BpmnXmlError) throw new DiscoveryInputError(error.message, error.status);
    throw error;
  }
  return {
    mode: "bpmn",
    file: {
      name: cleanFileName(value.name),
      type: value.type.toLowerCase() || "application/xml",
      size: value.size,
      arrayBuffer: () => value.arrayBuffer(),
    },
    bpmn_xml: cleaned,
  };
}

async function mediaInput(selectedMode: "bpmn" | "audio", value: FormDataEntryValue | null): Promise<DiscoveryInput> {
  if (!isUpload(value) || value.size === 0) {
    throw new DiscoveryInputError("A non-empty file is required for this mode.", 400);
  }
  const mime = value.type.toLowerCase();
  if (selectedMode === "bpmn" && hasBpmnExtension(value.name)) return bpmnXmlInput(value);
  const supported = selectedMode === "bpmn" ? BPMN_MIME_TYPES : AUDIO_MIME_TYPES;
  if (!supported.has(mime)) {
    throw new DiscoveryInputError(
      selectedMode === "bpmn"
        ? "BPMN input must be a PNG, JPEG or WebP image, or a .bpmn/.xml BPMN 2.0 file."
        : "Audio input must be AAC, FLAC, MP3, M4A, OGG, WAV or WebM.",
      415,
    );
  }
  const maximum = selectedMode === "bpmn" ? MAX_BPMN_BYTES : MAX_AUDIO_BYTES;
  if (value.size > maximum) {
    throw new DiscoveryInputError(
      `${selectedMode === "bpmn" ? "BPMN" : "Audio"} input is too large. The limit is ${maximum / 1024 / 1024} MB.`,
      413,
    );
  }
  return {
    mode: selectedMode,
    file: {
      name: cleanFileName(value.name),
      type: mime,
      size: value.size,
      arrayBuffer: () => value.arrayBuffer(),
    },
  };
}

async function readJsonInput(request: Request): Promise<DiscoveryInput> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new DiscoveryInputError("The request body must be valid JSON.", 400);
  }
  if (!isObject(value)) throw new DiscoveryInputError("The request body must be a JSON object.", 400);
  if (mode(value.mode) !== "text") {
    throw new DiscoveryInputError("JSON requests support text mode only; use multipart/form-data for files.", 415);
  }
  return { mode: "text", text: text(value.text) };
}

/** Read and validate a Discovery request before any model call is made. */
export async function readDiscoveryInput(request: Request): Promise<DiscoveryInput> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_MULTIPART_BYTES) {
    throw new DiscoveryInputError("The request body is too large.", 413);
  }

  if (contentType.startsWith("application/json")) return readJsonInput(request);
  if (!contentType.startsWith("multipart/form-data")) {
    throw new DiscoveryInputError("Use application/json for text or multipart/form-data for uploaded media.", 415);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new DiscoveryInputError("The multipart request could not be read.", 400);
  }
  const selectedMode = mode(form.get("mode"));
  if (selectedMode === "text") return { mode: "text", text: text(form.get("text")) };
  return mediaInput(selectedMode, form.get("file"));
}
