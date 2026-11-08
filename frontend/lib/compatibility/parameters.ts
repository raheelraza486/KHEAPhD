import type { CompareResult, Issue, NormalizedNode, SchemaEntry } from "./types.ts";
import { normalizeSchema, buildIndex } from "./normalize.ts";
import { primitiveRelation, typeOf } from "./relation.ts";
import { findMappingCandidateWithTier } from "./candidates.ts";
import { classifyIssues, makeIssue, summarizeIssues } from "./engine.ts";

/**
 * Parameter check — an addition beyond the upstream engine.
 *
 * The upstream schema check only looks at a target's request body. A query
 * operation such as `GET /invoices/{irn}` has no body: its whole input is
 * a handful of path/query parameters. Without this check such a target
 * would always come back "unknown". Here each path/query parameter the
 * target declares is looked up in the source's output schema with the same
 * name rules and tiers the field check uses.
 *
 * Header and cookie parameters (Authorization, Content-Type, ...) are
 * transport concerns, not data the source has to supply, so they are skipped.
 */

/** The subset of an OpenAPI Parameter Object we need. */
export interface OpenApiParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie" | string;
  required?: boolean;
  schema?: unknown;
}

const DATA_LOCATIONS = new Set(["path", "query"]);

export function compareParameters(
  sourceSchema: unknown,
  targetParameters: readonly OpenApiParameter[],
  sourceName: string,
  targetName: string,
): CompareResult {
  const normalizedSource = normalizeSchema(sourceSchema);
  const sourceIndex: SchemaEntry[] = buildIndex(normalizedSource, "$");
  const issues: Issue[] = [];
  const usedPaths = new Set<string>();

  // Path parameters are always required by the OpenAPI spec.
  const params = targetParameters
    .filter((p) => p && typeof p.name === "string" && DATA_LOCATIONS.has(p.in))
    .map((p) => ({ ...p, required: p.in === "path" ? true : Boolean(p.required) }));

  for (const param of params) {
    const targetNode = normalizeSchema(param.schema ?? { type: "string" });
    const targetPath = `${param.in}:${param.name}`;

    const exact = sourceIndex.find(
      (e) => e.path !== "$" && !usedPaths.has(e.path) && e.leaf === param.name,
    );
    if (exact) {
      usedPaths.add(exact.path);
      issues.push(
        makeIssue(
          "exact_parameter_match",
          "info",
          "information",
          exact.path,
          targetPath,
          `Parameter '${targetPath}' matches source field '${exact.path}' by exact name.`,
          "Same name does not guarantee same meaning — verify semantics if in doubt.",
        ),
      );
      pushTypeIssue(issues, exact.node, targetNode, exact.path, targetPath);
      continue;
    }

    const match = findMappingCandidateWithTier(param.name, targetNode, sourceIndex, usedPaths);
    if (match) {
      usedPaths.add(match.entry.path);
      const issue = makeIssue(
        "parameter_mapping_required",
        "mapping",
        "warning",
        match.entry.path,
        targetPath,
        `No source field named '${param.name}' was found, but '${match.entry.path}' looks like a compatible value for parameter '${targetPath}'.`,
        `Map '${match.entry.path}' to parameter '${targetPath}'.`,
      );
      issue.match_tier = match.tier;
      issue.match_alternatives = match.alternatives;
      issue.target_required = param.required === true;
      issues.push(issue);
      pushTypeIssue(issues, match.entry.node, targetNode, match.entry.path, targetPath);
    } else if (param.required) {
      issues.push(
        makeIssue(
          "missing_required_parameter",
          "blocking",
          "error",
          "$",
          targetPath,
          `Required parameter '${targetPath}' cannot be supplied from the source schema.`,
          "Add this value upstream or provide a mapping/default before calling the target API.",
        ),
      );
    } else {
      issues.push(
        makeIssue(
          "missing_optional_parameter",
          "info",
          "information",
          "$",
          targetPath,
          `Optional parameter '${targetPath}' is not provided by the source schema.`,
          "No action is required unless the target API needs it in practice.",
        ),
      );
    }
  }

  const compatibility = classifyIssues(issues);
  return {
    source: sourceName,
    target: targetName,
    compatibility,
    summary: summarizeIssues(issues, compatibility),
    issues,
    normalized_source: normalizedSource,
    normalized_target: { type: "object", properties: {}, required: [] },
  };
}

/** Same primitive rules the field check applies once a pair is matched. */
function pushTypeIssue(
  issues: Issue[],
  sourceNode: NormalizedNode,
  targetNode: NormalizedNode,
  sourcePath: string,
  targetPath: string,
): void {
  const relation = primitiveRelation(sourceNode, targetNode);
  if (relation === "direct") return;
  const sourceType = typeOf(sourceNode);
  const targetType = typeOf(targetNode);
  if (relation === "mapping") {
    issues.push(
      makeIssue(
        "type_conversion_required",
        "mapping",
        "warning",
        sourcePath,
        targetPath,
        `Source type '${sourceType}' can reach target type '${targetType}', but conversion is required.`,
        `Cast or transform '${sourcePath}' into '${targetType}' before sending it to '${targetPath}'.`,
      ),
    );
    return;
  }
  issues.push(
    makeIssue(
      "type_mismatch",
      "blocking",
      "error",
      sourcePath,
      targetPath,
      `Source type '${sourceType}' is not compatible with target type '${targetType}'.`,
      "Use a different API pair or insert a mapping/translation step that changes the data structure.",
    ),
  );
}
