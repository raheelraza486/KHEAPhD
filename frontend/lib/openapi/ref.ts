// Local $ref resolution, shared by the parser and the schema extractor.
//
// This began as a private function inside parse.ts. It moved here when schema
// extraction needed the same behaviour: two copies of a resolver that follows
// pointers and counts depth is the kind of duplication that drifts silently.
//
// External refs are not followed, on purpose. Resolving one means fetching a
// URL, and the fetcher refuses URLs supplied by documents for the same reason
// it validates the ones supplied by people. The unresolved ref becomes a
// warning, which is a fact a reviewer can act on.

const MAX_REF_DEPTH = 10;

export type JsonObject = Record<string, unknown>;

export function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Follow local $ref ("#/a/b") only. External refs return undefined and warn. */
export function resolveRef(
  node: unknown,
  root: JsonObject,
  warnings: string[],
  depth = 0,
): unknown {
  if (!isObject(node) || typeof node.$ref !== "string") return node;
  if (depth >= MAX_REF_DEPTH) {
    warnings.push(`$ref depth limit reached at ${node.$ref}`);
    return undefined;
  }
  const ref = node.$ref;
  if (!ref.startsWith("#/")) {
    warnings.push(`external $ref not resolved: ${ref}`);
    return undefined;
  }
  let target: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isObject(target) || !(key in target)) {
      warnings.push(`$ref target not found: ${ref}`);
      return undefined;
    }
    target = target[key];
  }
  return resolveRef(target, root, warnings, depth + 1);
}

/** The pointer a node states, or null when it states none. */
export function refOf(node: unknown): string | null {
  return isObject(node) && typeof node.$ref === "string" ? node.$ref : null;
}
