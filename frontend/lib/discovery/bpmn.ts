export const MAX_BPMN_XML_BYTES = 1024 * 1024;

const BPMN_MODEL_NAMESPACE = "http://www.omg.org/spec/BPMN/20100524/MODEL";
const BPMN_DI_NAMESPACE = "http://www.omg.org/spec/BPMN/20100524/DI";
const MARKUP_OPEN = String.fromCharCode(60);

export class BpmnXmlError extends Error {
  readonly status: 413 | 415;

  constructor(message: string, status: 413 | 415) {
    super(message);
    this.name = "BpmnXmlError";
    this.status = status;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function hasBpmnExtension(name: string): boolean {
  return /\.(?:bpmn|xml)$/i.test(name);
}

function assertBpmnDefinitions(xml: string): void {
  if (new RegExp(`${MARKUP_OPEN}!DOCTYPE\\b`, "i").test(xml)) {
    throw new BpmnXmlError("BPMN XML with a DOCTYPE is not supported.", 415);
  }

  const declaration = new RegExp(`^\\s*${MARKUP_OPEN}\\?xml[\\s\\S]*?\\?>`, "i");
  const comments = new RegExp(`^(?:\\s*${MARKUP_OPEN}!--[\\s\\S]*?-->)*\\s*`);
  const definitions = new RegExp(`^${MARKUP_OPEN}(?:([A-Za-z_][\\w.-]*):)?definitions\\b([^>]*)>`, "i");
  const withoutPreamble = xml
    .replace(/^\uFEFF/, "")
    .replace(declaration, "")
    .replace(comments, "");
  const root = definitions.exec(withoutPreamble);
  if (!root) {
    throw new BpmnXmlError("The XML file must have a BPMN 2.0 definitions root.", 415);
  }

  const prefix = root[1];
  const attributes = root[2];
  const namespaceName = prefix ? `xmlns:${escapeRegExp(prefix)}` : "xmlns";
  const namespace = new RegExp(`\\b${namespaceName}\\s*=\\s*([\"'])${escapeRegExp(BPMN_MODEL_NAMESPACE)}\\1`, "i");
  if (!namespace.test(attributes)) {
    throw new BpmnXmlError("The XML definitions root must use the BPMN 2.0 model namespace.", 415);
  }
}

/** Remove BPMN diagram interchange layout while retaining semantic flow nodes and sequenceFlow edges. */
export function stripBpmnDiagram(xml: string): string {
  const prefixes = new Set<string>();
  const declaration = /\bxmlns:([A-Za-z_][\w.-]*)\s*=\s*([\"'])http:\/\/www\.omg\.org\/spec\/BPMN\/20100524\/DI\2/gi;
  for (const match of xml.matchAll(declaration)) prefixes.add(match[1]);
  if (xml.includes(BPMN_DI_NAMESPACE)) prefixes.add("bpmndi");

  let result = xml;
  for (const prefix of prefixes) {
    const name = escapeRegExp(prefix);
    result = result
      .replace(new RegExp(`<${name}:BPMNDiagram\\b[^>]*>[\\s\\S]*?<\\/${name}:BPMNDiagram\\s*>`, "gi"), "")
      .replace(new RegExp(`<${name}:BPMNDiagram\\b[^>]*/\\s*>`, "gi"), "");
  }
  return result.trim();
}

export async function readBpmnXml(file: { size: number; arrayBuffer(): Promise<ArrayBuffer> }): Promise<string> {
  if (file.size > MAX_BPMN_XML_BYTES) {
    throw new BpmnXmlError("BPMN XML input is too large. The limit is 1 MB.", 413);
  }

  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
  } catch {
    throw new BpmnXmlError("BPMN XML must be valid UTF-8 text.", 415);
  }
  assertBpmnDefinitions(xml);
  return stripBpmnDiagram(xml);
}
