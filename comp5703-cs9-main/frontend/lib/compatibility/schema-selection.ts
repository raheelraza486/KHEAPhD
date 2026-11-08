import type { ApiSchemaAvailability, ApiSchemaRecord } from "./ui-types.ts";

/** A schema row without fields cannot participate in field compatibility. */
export function comparisonReadySchemas(
  schemas: readonly ApiSchemaRecord[],
  direction: "request" | "response",
): ApiSchemaRecord[] {
  return schemas.filter((schema) => schema.direction === direction && schema.fields.length > 0);
}

export function defaultApiPair(
  apis: readonly { id: string }[],
  availability: ReadonlyMap<string, ApiSchemaAvailability>,
): { sourceId: string; targetId: string } {
  const sources = apis.filter((api) => (availability.get(api.id)?.response_count ?? 0) > 0);
  const targets = apis.filter((api) => (availability.get(api.id)?.request_count ?? 0) > 0);
  const source = sources.find((candidate) => targets.some((target) => target.id !== candidate.id)) ?? sources[0] ?? apis[0];
  const target = targets.find((candidate) => candidate.id !== source?.id) ?? apis.find((candidate) => candidate.id !== source?.id);
  return { sourceId: source?.id ?? "", targetId: target?.id ?? "" };
}

export function schemaAvailabilityLabel(count: number | undefined, direction: "request" | "response"): string {
  if (count === undefined) return "Schema availability unknown";
  return count > 0 ? `${count} saved ${direction} schema${count === 1 ? "" : "s"}` : `No saved ${direction} schema`;
}

export function schemaSourceLink(source: string): string | undefined {
  try {
    const url = new URL(source);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}
