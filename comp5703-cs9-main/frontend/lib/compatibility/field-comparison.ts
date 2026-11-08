import type { ArrayNode, CompareResult, Issue, NormalizedNode, ObjectNode } from "./types.ts";
import type { OpenApiParameter } from "./parameters.ts";
import { normalizeSchema } from "./normalize.ts";
import { typeOf } from "./relation.ts";

export type FieldVerdict = "exact" | "mapping" | "blocking" | "source-only" | "target-only" | "information";
export interface FlatField { path: string; type: string; required: boolean | null }
export interface FieldComparisonRow {
  id: string;
  source: FlatField | null;
  target: FlatField | null;
  verdict: FieldVerdict;
  message: string;
  suggestion?: string;
  issues: Issue[];
}

export function flattenSchema(node?: NormalizedNode): FlatField[] {
  const rows: FlatField[] = [];
  function walk(current: NormalizedNode, path: string, required: boolean) {
    const type = typeof (current as { type?: unknown }).type === "string"
      ? (current as { type: string }).type
      : "unknown";
    if (path !== "$") rows.push({ path, type, required });
    if (type === "object") {
      const object = current as ObjectNode;
      const requiredKeys = new Set(object.required ?? []);
      for (const [key, child] of Object.entries(object.properties ?? {})) {
        walk(child, path === "$" ? key : `${path}.${key}`, requiredKeys.has(key));
      }
    } else if (type === "array") {
      walk((current as ArrayNode).items, path === "$" ? "[]" : `${path}[]`, required);
    }
  }
  if (node) walk(node, "$", false);
  return rows;
}

function fieldAt(fields: FlatField[], path: string, root: NormalizedNode): FlatField | null {
  if (path === "$") return { path, type: typeOf(root), required: null };
  const fieldPath = path.replace(/^\$(?=\[)/, "");
  return fields.find((field) => field.path === fieldPath) ?? null;
}
function verdictOf(issue: Issue): FieldVerdict {
  if (issue.kind === "blocking") return "blocking";
  if (issue.kind === "mapping") return "mapping";
  if (issue.code.includes("exact")) return "exact";
  return "information";
}

export function isFieldComparisonIssue(row: FieldComparisonRow): boolean {
  return row.verdict === "blocking" || row.verdict === "mapping";
}

export function buildFieldComparison(
  result: CompareResult,
  targetParameters: readonly OpenApiParameter[] = [],
): FieldComparisonRow[] {
  const sourceFields = flattenSchema(result.normalized_source);
  const targetFields = flattenSchema(result.normalized_target);
  const parameterFields = new Map<string, FlatField>();
  for (const parameter of targetParameters) {
    if (parameter.in !== "path" && parameter.in !== "query") continue;
    const path = `${parameter.in}:${parameter.name}`;
    parameterFields.set(path, {
      path,
      type: typeOf(normalizeSchema(parameter.schema ?? { type: "string" })),
      required: parameter.in === "path" || Boolean(parameter.required),
    });
  }
  const usedSource = new Set<string>();
  const usedTarget = new Set<string>();
  // A name match and a type conversion can refer to the same pair. Present one
  // row with the strongest verdict so an exact-name issue cannot hide a failure.
  const groups = new Map<string, Issue[]>();
  for (const issue of result.issues) {
    const key = JSON.stringify([issue.source_path, issue.target_path]);
    const group = groups.get(key) ?? [];
    group.push(issue);
    groups.set(key, group);
  }
  const rank = { blocking: 2, mapping: 1, info: 0 };
  const rows = [...groups.entries()].map(([key, issues]): FieldComparisonRow => {
    const strongest = issues.reduce((left, right) => rank[right.kind] > rank[left.kind] ? right : left);
    const primaryIssues = issues.filter((issue) => issue.kind === strongest.kind);
    const issue = strongest;
    const source = issue.source_path && !issue.code.startsWith("missing_")
      ? fieldAt(sourceFields, issue.source_path, result.normalized_source)
      : null;
    const target = issue.target_path.startsWith("path:") || issue.target_path.startsWith("query:")
      ? parameterFields.get(issue.target_path) ?? { path: issue.target_path, type: "unknown", required: null }
      : issue.target_path && issue.code !== "extra_source_field"
        ? fieldAt(targetFields, issue.target_path, result.normalized_target)
        : null;
    if (source) usedSource.add(source.path);
    if (target && !target.path.includes(":")) usedTarget.add(target.path);
    return {
      id: `field-${key}`,
      source,
      target,
      verdict: verdictOf(issue),
      message: [...new Set(primaryIssues.map((item) => item.message))].join(" "),
      suggestion: [...new Set(primaryIssues.map((item) => item.suggestion).filter(Boolean))].join(" ") || undefined,
      issues,
    };
  });
  for (const source of sourceFields) {
    if (!usedSource.has(source.path)) rows.push({ id: `source-${source.path}`, source, target: null, verdict: "source-only", message: "Source field has no reported target counterpart.", issues: [] });
  }
  for (const target of targetFields) {
    if (!usedTarget.has(target.path)) rows.push({ id: `target-${target.path}`, source: null, target, verdict: "target-only", message: "Target field has no reported source counterpart.", issues: [] });
  }
  return rows;
}
