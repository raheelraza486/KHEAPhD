import { parse as parseYaml } from "yaml";
import type { OpenApiParameter } from "./parameters.ts";

type JsonObject = Record<string, unknown>;
type Side = "source" | "target";
const METHODS = ["get", "post", "put", "patch", "delete", "options", "head", "trace"];
const asObject = (value: unknown): JsonObject | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : null;

export interface ParsedSchemaInput {
  id: string;
  schema?: unknown;
  parameters?: OpenApiParameter[];
  operationLabel: string;
  mediaType?: string;
  warnings?: string[];
}

export async function inspectSchemaFile(file: File, side: Side): Promise<ParsedSchemaInput[]> {
  if (file.size > 5 * 1024 * 1024) throw new Error("Choose a schema file smaller than 5 MB.");
  const text = await file.text();
  let value: unknown;
  try {
    value = file.name.toLowerCase().endsWith(".json") ? JSON.parse(text) : parseYaml(text);
  } catch {
    throw new Error(`${side === "source" ? "Source" : "Target"} file is not valid JSON or YAML.`);
  }
  return extractSchemaChoices(value, side);
}

/** Legacy callers retain the first usable choice; the UI should use inspectSchemaFile. */
export async function parseSchemaFile(file: File, side: Side): Promise<ParsedSchemaInput> {
  return (await inspectSchemaFile(file, side))[0];
}

export function extractSchemaInput(value: unknown, side: Side): ParsedSchemaInput {
  return extractSchemaChoices(value, side)[0];
}

export function extractSchemaChoices(value: unknown, side: Side): ParsedSchemaInput[] {
  const root = asObject(value);
  if (!root) throw new Error("Schema file must contain an object.");
  const paths = asObject(root.paths);
  if (!paths) {
    if ("openapi" in root || "swagger" in root) throw new Error("The OpenAPI document does not contain paths.");
    assertSchema(root);
    return [{ id: "schema-fragment", schema: resolveSchema(root, root), operationLabel: "Schema fragment" }];
  }
  if ("swagger" in root) throw new Error("Upload OpenAPI 3.x or a JSON Schema fragment; Swagger 2.0 is not supported here.");
  const choices: ParsedSchemaInput[] = [];
  const warnings: string[] = [];
  const attempt = (label: string, read: () => void) => {
    try { read(); } catch (error) {
      warnings.push(`${label}: ${error instanceof Error ? error.message : "Could not read this choice."}`);
    }
  };
  function addContentChoices(contentValue: unknown, label: string, identity: string[], parameters?: OpenApiParameter[]) {
    const content = asObject(contentValue);
    if (!content) return;
    for (const [mediaType, mediaValue] of Object.entries(content)) {
      const media = asObject(mediaValue);
      const mediaLabel = `${label} · ${mediaType}`;
      attempt(mediaLabel, () => {
        if (!media || !("schema" in media)) throw new Error("No schema is provided for this media type.");
        assertSchema(media.schema);
        choices.push({ id: JSON.stringify([...identity, mediaType]), schema: resolveSchema(media.schema, root!), parameters, operationLabel: mediaLabel, mediaType });
      });
    }
  }
  for (const [path, pathValue] of Object.entries(paths)) {
    if (!path.startsWith("/")) continue;
    attempt(path, () => {
      const pathItem = resolveObject(pathValue, root);
      if (!pathItem) return;
      for (const method of METHODS) {
        const label = `${method.toUpperCase()} ${path}`;
        attempt(label, () => {
          const operation = asObject(pathItem[method]);
          if (!operation) return;
          if (side === "source") {
            const responses = asObject(operation.responses);
            if (!responses) return;
            // Keep success responses first; error responses remain explicitly selectable.
            const rank = (code: string) => /^2\d\d$|^2XX$/i.test(code) ? 0 : code === "default" ? 1 : 2;
            for (const [status, responseValue] of Object.entries(responses).sort(([a], [b]) => rank(a) - rank(b))) {
              if (status.startsWith("x-")) continue;
              const responseLabel = `${label} · ${status} response`;
              attempt(responseLabel, () => {
                const response = resolveObject(responseValue, root);
                addContentChoices(response?.content, responseLabel, [method, path, status]);
              });
            }
          } else {
            const parameters = readParameters(pathItem.parameters, operation.parameters, root);
            const requestLabel = `${label} · request`;
            const requestBody = resolveObject(operation.requestBody, root);
            if (requestBody) {
              // An unsupported request body must not silently become a parameters-only check.
              addContentChoices(requestBody.content, requestLabel, [method, path, "request"], parameters);
            } else if (parameters.length) {
              choices.push({ id: JSON.stringify([method, path, "parameters"]), parameters, operationLabel: `${requestLabel} · path/query parameters` });
            }
          }
        });
      }
    });
  }
  if (!choices.length) {
    const message = side === "source"
      ? "No usable response schema was found in the source OpenAPI document."
      : "No usable request body schema or path/query parameters were found in the target OpenAPI document.";
    throw new Error(`${message}${warnings.length ? ` ${warnings.join(" ")}` : ""}`);
  }
  if (warnings.length) for (const choice of choices) choice.warnings = [...new Set(warnings)];
  return choices;
}

function readParameters(pathValue: unknown, operationValue: unknown, root: JsonObject): OpenApiParameter[] {
  const parameters = new Map<string, JsonObject>();
  for (const value of [...(Array.isArray(pathValue) ? pathValue : []), ...(Array.isArray(operationValue) ? operationValue : [])]) {
    const parameter = resolveObject(value, root);
    if (!parameter || typeof parameter.name !== "string" || typeof parameter.in !== "string") continue;
    if (parameter.in !== "path" && parameter.in !== "query") continue;
    parameters.set(`${parameter.in}:${parameter.name}`, parameter);
  }
  return [...parameters.values()].map((parameter) => {
    if (!("schema" in parameter)) throw new Error(`Parameter '${parameter.name}' needs a schema; content-based parameters are not supported.`);
    assertSchema(parameter.schema);
    return {
      name: parameter.name as string,
      in: parameter.in as string,
      required: parameter.in === "path" || parameter.required === true,
      schema: resolveSchema(parameter.schema, root),
    };
  });
}

function referencedValue(ref: string, root: JsonObject): unknown {
  if (ref !== "#" && !ref.startsWith("#/")) throw new Error(`Reference '${ref}' is not a local JSON pointer. External and anchor references are not supported.`);
  let current: unknown = root;
  if (ref === "#") return current;
  for (const segment of ref.slice(2).split("/")) {
    const key = decodeURIComponent(segment).replace(/~1/g, "/").replace(/~0/g, "~");
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, key)) throw new Error(`Reference '${ref}' could not be found in this file.`);
    current = (current as JsonObject)[key];
  }
  return current;
}

/** Resolve OpenAPI container refs without expanding unrelated operations. */
function resolveObject(value: unknown, root: JsonObject, refs = new Set<string>()): JsonObject | null {
  const object = asObject(value);
  if (!object || !("$ref" in object)) return object;
  if (typeof object.$ref !== "string") throw new Error("A $ref must be a string.");
  if (refs.has(object.$ref)) throw new Error(`Circular reference '${object.$ref}' is not supported.`);
  const resolved = resolveObject(referencedValue(object.$ref, root), root, new Set(refs).add(object.$ref));
  if (!resolved) throw new Error(`Reference '${object.$ref}' does not point to an object.`);
  const { $ref: _ref, ...siblings } = object;
  return { ...resolved, ...siblings };
}

const SCHEMA_KEYS = new Set(["$schema", "$id", "$ref", "$defs", "definitions", "type", "properties", "items", "prefixItems", "required", "allOf", "anyOf", "oneOf", "not", "enum", "const", "additionalProperties", "patternProperties", "title", "description", "format", "root", "schema"]);
function assertSchema(value: unknown): asserts value is JsonObject {
  const object = asObject(value);
  if (!object) throw new Error("This comparison requires an object schema.");
  if (Object.keys(object).length && !Object.keys(object).some((key) => SCHEMA_KEYS.has(key))) throw new Error("This object does not look like a JSON Schema. Upload the schema, not example data.");
}

const SCHEMA_MAPS = new Set(["properties", "patternProperties", "dependentSchemas", "attributes"]);
const SCHEMA_ARRAYS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const SCHEMA_CHILDREN = new Set(["items", "additionalItems", "additionalProperties", "contains", "not", "if", "then", "else", "propertyNames", "unevaluatedProperties", "unevaluatedItems", "schema"]);

/** Inline schema children; example values and unused definitions are not references. */
function resolveSchema(value: unknown, root: JsonObject, refs = new Set<string>(), ancestors = new Set<object>(), depth = 0): unknown {
  if (depth > 100) throw new Error("This schema is too deeply nested to inspect safely.");
  const object = asObject(value);
  if (!object) return value;
  if (ancestors.has(object)) throw new Error("Circular schema aliases are not supported.");
  if ("$dynamicRef" in object || "$recursiveRef" in object) throw new Error("Dynamic and recursive schema references are not supported.");
  const nextAncestors = new Set(ancestors).add(object);
  if ("$ref" in object) {
    if (typeof object.$ref !== "string") throw new Error("A $ref must be a string.");
    if (refs.has(object.$ref)) throw new Error(`Circular reference '${object.$ref}' is not supported.`);
    const target = referencedValue(object.$ref, root);
    assertSchema(target);
    const resolved = resolveSchema(target, root, new Set(refs).add(object.$ref), nextAncestors, depth + 1);
    const { $ref: _ref, $defs: _defs, definitions: _definitions, ...siblings } = object;
    return Object.keys(siblings).length ? { allOf: [resolved, resolveSchema(siblings, root, refs, nextAncestors, depth + 1)] } : resolved;
  }
  const result: JsonObject = {};
  for (const [key, child] of Object.entries(object)) {
    if (key === "$defs" || key === "definitions") continue;
    if (SCHEMA_MAPS.has(key) && asObject(child)) {
      result[key] = Object.fromEntries(Object.entries(child as JsonObject).map(([name, schema]) => [name, resolveSchema(schema, root, refs, nextAncestors, depth + 1)]));
    } else if ((SCHEMA_ARRAYS.has(key) || key === "items") && Array.isArray(child)) {
      result[key] = child.map((schema) => resolveSchema(schema, root, refs, nextAncestors, depth + 1));
    } else if (SCHEMA_CHILDREN.has(key)) {
      result[key] = resolveSchema(child, root, refs, nextAncestors, depth + 1);
    } else result[key] = child;
  }
  return result;
}
