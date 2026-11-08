import type {
  ArrayNode,
  CompareResult,
  CompareSummary,
  CompatibilityLevel,
  Issue,
  IssueCode,
  IssueKind,
  IssueSeverity,
  NormalizedNode,
  ObjectNode,
  SchemaEntry,
} from "./types.ts";
import { normalizeSchema, buildIndex } from "./normalize.ts";
import { primitiveRelation, typeOf } from "./relation.ts";
import { findMappingCandidateWithTier } from "./candidates.ts";
import { pyReprList, sortedByStr } from "./py-repr.ts";

export const DIRECT: CompatibilityLevel = "directly_compatible";
export const MAPPING: CompatibilityLevel = "compatible_with_mapping";
export const INCOMPATIBLE: CompatibilityLevel = "incompatible";

// ---------------------------------------------------------------- issues

export { pyReprList, sortedByStr } from "./py-repr.ts";

export function makeIssue(
  code: IssueCode,
  kind: IssueKind,
  severity: IssueSeverity,
  sourcePath: string,
  targetPath: string,
  message: string,
  suggestion: string,
): Issue {
  return { code, kind, severity, source_path: sourcePath, target_path: targetPath, message, suggestion };
}

export function classifyIssues(issues: Issue[]): CompatibilityLevel {
  if (issues.some((i) => i.kind === "blocking")) return INCOMPATIBLE;
  if (issues.some((i) => i.kind === "mapping")) return MAPPING;
  return DIRECT;
}

export function summarizeIssues(issues: Issue[], compatibility: CompatibilityLevel): CompareSummary {
  const label =
    compatibility === DIRECT
      ? "Directly compatible"
      : compatibility === MAPPING
        ? "Compatible with mapping"
        : "Incompatible";
  return {
    compatibility_label: label,
    blocking_issues: issues.filter((i) => i.kind === "blocking").length,
    mapping_issues: issues.filter((i) => i.kind === "mapping").length,
    informational_issues: issues.filter((i) => i.kind === "info").length,
    issue_count: issues.length,
  };
}

// ---------------------------------------------------------------- python repr
// ---------------------------------------------------------------- enum

function enumSet(node: NormalizedNode): Set<unknown> {
  const e = (node as { enum?: unknown }).enum;
  return new Set(Array.isArray(e) ? e : []);
}

/**
 * Target has no enum -> nothing to check. Source has no enum -> free values,
 * nothing to check. Otherwise: no overlap is blocking; source values outside
 * the target set need translation; a subset is fine.
 */
export function compareEnum(
  sourceNode: NormalizedNode,
  targetNode: NormalizedNode,
  sourcePath: string,
  targetPath: string,
): Issue | null {
  const sourceEnum = enumSet(sourceNode);
  const targetEnum = enumSet(targetNode);
  if (targetEnum.size === 0) return null;
  if (sourceEnum.size > 0) {
    const overlap = [...sourceEnum].filter((v) => targetEnum.has(v));
    if (overlap.length === 0) {
      return makeIssue(
        "enum_mismatch",
        "blocking",
        "error",
        sourcePath,
        targetPath,
        `Source enum values ${pyReprList(sortedByStr(sourceEnum))} do not overlap with target enum values ${pyReprList(sortedByStr(targetEnum))}.`,
        "Use a compatible API, or translate values into the target enum set.",
      );
    }
    const notAccepted = [...sourceEnum].filter((v) => !targetEnum.has(v));
    if (notAccepted.length > 0) {
      // Upstream stops at the first sentence; naming the offending values is our addition.
      return makeIssue(
        "enum_mapping_required",
        "mapping",
        "warning",
        sourcePath,
        targetPath,
        `Source enum contains values outside the target enum. Value translation may be required. Values not accepted by the target: ${pyReprList(sortedByStr(new Set(notAccepted)))}.`,
        "Constrain or map source enum values before sending them to the target.",
      );
    }
  }
  return null;
}

// ---------------------------------------------------------------- walk

function propsOf(node: NormalizedNode): Record<string, NormalizedNode> {
  const p = (node as ObjectNode).properties;
  return p && typeof p === "object" ? p : {};
}

function itemsOf(node: NormalizedNode): NormalizedNode {
  return (node as ArrayNode).items ?? { type: "unknown" };
}

function requiredOf(node: NormalizedNode): Set<string> {
  const r = (node as ObjectNode).required;
  return new Set(Array.isArray(r) ? r.map(String) : []);
}

function compareNodes(
  sourceNode: NormalizedNode,
  targetNode: NormalizedNode,
  sourcePath: string,
  targetPath: string,
  sourceIndex: SchemaEntry[],
  issues: Issue[],
  usedPaths: Set<string>,
): void {
  const sourceType = typeOf(sourceNode);
  const targetType = typeOf(targetNode);

  const enumIssue = compareEnum(sourceNode, targetNode, sourcePath, targetPath);
  if (enumIssue) {
    issues.push(enumIssue);
    if (enumIssue.kind === "blocking") return;
  }

  // ---- target is an object
  if (targetType === "object") {
    if (sourceType === "array") {
      issues.push(
        makeIssue(
          "array_to_object_mapping",
          "mapping",
          "warning",
          sourcePath,
          targetPath,
          "Target expects an object but source provides an array. A wrap/unwrap mapping is needed.",
          "Map one array item into the required object shape or aggregate before forwarding.",
        ),
      );
      compareNodes(itemsOf(sourceNode), targetNode, `${sourcePath}[]`, targetPath, sourceIndex, issues, usedPaths);
      return;
    }
    if (sourceType !== "object") {
      issues.push(
        makeIssue(
          "structural_mismatch",
          "blocking",
          "error",
          sourcePath,
          targetPath,
          `Target expects an object but source provides ${sourceType}.`,
          "Provide an object-producing source or define a structural mapping layer.",
        ),
      );
      return;
    }

    const sourceProps = propsOf(sourceNode);
    const targetProps = propsOf(targetNode);
    const targetRequired = requiredOf(targetNode);
    const matchedExact = new Set<string>();

    for (const [targetKey, targetChild] of Object.entries(targetProps)) {
      const childTargetPath = targetPath === "$" ? targetKey : `${targetPath}.${targetKey}`;

      if (Object.prototype.hasOwnProperty.call(sourceProps, targetKey)) {
        matchedExact.add(targetKey);
        const childSourcePath = sourcePath === "$" ? targetKey : `${sourcePath}.${targetKey}`;
        usedPaths.add(childSourcePath);
        // visibility only; info-level issues never affect classifyIssues
        issues.push(
          makeIssue(
            "exact_path_match",
            "info",
            "information",
            childSourcePath,
            childTargetPath,
            `'${childTargetPath}' matches '${childSourcePath}' by exact field name.`,
            "Same name does not guarantee same meaning — verify semantics if in doubt.",
          ),
        );
        compareNodes(sourceProps[targetKey], targetChild, childSourcePath, childTargetPath, sourceIndex, issues, usedPaths);
        continue;
      }

      const match = findMappingCandidateWithTier(targetKey, targetChild, sourceIndex, usedPaths);
      if (match) {
        usedPaths.add(match.entry.path);
        const mappingIssue = makeIssue(
          "field_mapping_required",
          "mapping",
          "warning",
          match.entry.path,
          childTargetPath,
          `No exact field named '${targetKey}' was found at this level, but '${match.entry.path}' looks like a compatible source field.`,
          `Map '${match.entry.path}' to '${childTargetPath}'.`,
        );
        mappingIssue.match_tier = match.tier;
        // Recorded, not acted on. Whether the choice was forced, and whether
        // anything depends on it, are the two things this issue used to leave
        // unsaid -- see the field comments in types.ts.
        mappingIssue.match_alternatives = match.alternatives;
        mappingIssue.target_required = targetRequired.has(targetKey);
        issues.push(mappingIssue);
        compareNodes(match.entry.node, targetChild, match.entry.path, childTargetPath, sourceIndex, issues, usedPaths);
      } else if (targetRequired.has(targetKey)) {
        issues.push(
          makeIssue(
            "missing_required_field",
            "blocking",
            "error",
            sourcePath,
            childTargetPath,
            `Required target field '${childTargetPath}' does not exist in the source schema.`,
            "Add this field upstream or provide a mapping/default value before calling the target API.",
          ),
        );
      } else {
        issues.push(
          makeIssue(
            "missing_optional_field",
            "info",
            "information",
            sourcePath,
            childTargetPath,
            `Optional target field '${childTargetPath}' is not provided by the source schema.`,
            "No action is required unless the target API needs a default value in practice.",
          ),
        );
      }
    }

    for (const sourceKey of Object.keys(sourceProps)) {
      if (matchedExact.has(sourceKey)) continue;
      const childSourcePath = sourcePath === "$" ? sourceKey : `${sourcePath}.${sourceKey}`;
      if (!usedPaths.has(childSourcePath)) {
        issues.push(
          makeIssue(
            "extra_source_field",
            "info",
            "information",
            childSourcePath,
            targetPath,
            `Source field '${childSourcePath}' has no direct target counterpart.`,
            "This is usually safe if the target ignores unknown fields. Otherwise drop it during mapping.",
          ),
        );
      }
    }
    return;
  }

  // ---- target is an array
  if (targetType === "array") {
    if (sourceType === "array") {
      compareNodes(
        itemsOf(sourceNode),
        itemsOf(targetNode),
        `${sourcePath}[]`,
        `${targetPath}[]`,
        sourceIndex,
        issues,
        usedPaths,
      );
      return;
    }
    const relation = primitiveRelation(sourceNode, itemsOf(targetNode));
    if (relation === "direct" || relation === "mapping") {
      issues.push(
        makeIssue(
          "singleton_array_mapping",
          "mapping",
          "warning",
          sourcePath,
          targetPath,
          "Target expects an array but source provides a single value/object. A wrap-to-array mapping is needed.",
          "Wrap the source value into a one-element array before forwarding.",
        ),
      );
      return;
    }
    issues.push(
      makeIssue(
        "array_type_mismatch",
        "blocking",
        "error",
        sourcePath,
        targetPath,
        `Target expects an array but source provides ${sourceType} and the item types are not compatible.`,
        "Choose a different source or build a mediator that produces the required array structure.",
      ),
    );
    return;
  }

  // ---- target is a primitive
  const relation = primitiveRelation(sourceNode, targetNode);
  if (relation === "direct") {
    // Addition beyond upstream: same type, different value convention
    // (e.g. date-time vs date) still needs a conversion step.
    const sf = (sourceNode as { format?: unknown }).format;
    const tf = (targetNode as { format?: unknown }).format;
    if (typeof sf === "string" && typeof tf === "string" && sf !== tf) {
      issues.push(
        makeIssue(
          "format_conversion_required",
          "mapping",
          "warning",
          sourcePath,
          targetPath,
          `Source value format '${sf}' differs from target value format '${tf}'; a value conversion is required.`,
          `Convert '${sourcePath}' from ${sf} to ${tf} before sending it to '${targetPath}'.`,
        ),
      );
    }
    return;
  }
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

// ---------------------------------------------------------------- entry point

function variantsOf(normalized: NormalizedNode): NormalizedNode[] {
  const one = (normalized as { oneOf?: unknown }).oneOf;
  if (Array.isArray(one)) return one as NormalizedNode[];
  const any = (normalized as { anyOf?: unknown }).anyOf;
  if (Array.isArray(any)) return any as NormalizedNode[];
  return [normalized];
}

function compareSingleVariant(
  source: NormalizedNode,
  target: NormalizedNode,
  sourceName: string,
  targetName: string,
): CompareResult {
  const issues: Issue[] = [];
  const sourceIndex = buildIndex(source, "$");
  const usedPaths = new Set<string>();
  compareNodes(source, target, "$", "$", sourceIndex, issues, usedPaths);
  const compatibility = classifyIssues(issues);
  return {
    source: sourceName,
    target: targetName,
    compatibility,
    summary: summarizeIssues(issues, compatibility),
    issues,
    normalized_source: source,
    normalized_target: target,
  };
}

/** (level order, blocking count, mapping count) — smaller is better. */
function scoreResult(result: CompareResult): [number, number, number] {
  const order = result.compatibility === DIRECT ? 0 : result.compatibility === MAPPING ? 1 : 2;
  return [
    order,
    result.issues.filter((i) => i.kind === "blocking").length,
    result.issues.filter((i) => i.kind === "mapping").length,
  ];
}

function lessThan(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

/**
 * Compare a source (output) schema against a target (input) schema.
 * Both inputs are normalised first; when either side is a oneOf/anyOf,
 * every variant pair is compared and the best-scoring result is returned.
 */
export function compareSchemas(
  sourceSchema: unknown,
  targetSchema: unknown,
  sourceName: string,
  targetName: string,
): CompareResult {
  const normalizedSource = normalizeSchema(sourceSchema);
  const normalizedTarget = normalizeSchema(targetSchema);
  const sourceVariants = variantsOf(normalizedSource);
  const targetVariants = variantsOf(normalizedTarget);

  let best: CompareResult | null = null;
  let bestScore: [number, number, number] | null = null;
  for (let s = 0; s < sourceVariants.length; s++) {
    for (let t = 0; t < targetVariants.length; t++) {
      const result = compareSingleVariant(sourceVariants[s], targetVariants[t], sourceName, targetName);
      const score = scoreResult(result);
      if (bestScore === null || lessThan(score, bestScore)) {
        bestScore = score;
        best = result;
        best.chosen_variant = { source_variant_index: s, target_variant_index: t };
      }
    }
  }
  // sourceVariants/targetVariants are never empty, so best is always set.
  return best as CompareResult;
}
