import type { CheckReport } from "@/lib/checks/types";
import type { ApiSchemaField } from "@/lib/compatibility/ui-types";

export type ConnectionResolutionKind = "transformation" | "enrichment" | "derived" | "missing";

export interface ConnectionResolution {
  targetPath: string;
  kind: ConnectionResolutionKind;
  sourcePath: string | null;
  title: string;
  detail: string;
  steps: string[];
}

export interface ConnectionPotential {
  directLabel: "Directly compatible" | "Not directly compatible" | "Decision required";
  potentialLabel: "No additional steps required" | "Possible with transformation" | "Possible with external enrichment" | "No known connection path";
  potentialKind: "direct" | "transformation" | "enrichment" | "incompatible";
  summary: string;
  resolutions: ConnectionResolution[];
}

function normalized(field: ApiSchemaField): string {
  return (field.leaf_name_norm || field.leaf_name || field.path.split(".").at(-1) || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function pathNorm(path: string): string {
  return (path.split(".").at(-1) || path).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function fieldForPath(fields: readonly ApiSchemaField[], path: string): ApiSchemaField | undefined {
  return fields.find((field) => field.path === path)
    ?? fields.find((field) => normalized(field) === pathNorm(path));
}

function isDocumentValue(field: ApiSchemaField): boolean {
  const name = normalized(field);
  const description = field.description?.toLowerCase() ?? "";
  const documentName = /^(invoice|invoicexml|invoicedocument|document|documentbody|payload|ubl|ublfile|xml|xmlbytes|xmlbase64bytes|xmlbytesbase64)$/.test(name);
  const documentDescription = /(?:entire|complete|whole|full).{0,24}(?:invoice|document)|(?:invoice|document).{0,36}(?:base64|xml|ubl|encoded|payload)/.test(description);
  return !/(?:hash|digest|id|identifier|number|key|reference)$/.test(name) && (documentName || documentDescription);
}

function isLookupKey(field: ApiSchemaField): boolean {
  const name = normalized(field);
  return /^(?:purchaseorder|invoice|document|order)(?:id|identifier|number|key|reference|uuid)$/.test(name)
    || /^(?:id|identifier|number|key|reference|uuid)(?:purchaseorder|invoice|document|order)$/.test(name);
}

function isDerivedDigest(field: ApiSchemaField): boolean {
  return /(?:hash|digest|checksum)$/.test(normalized(field));
}

function digestDependency(field: ApiSchemaField, targetFields: readonly ApiSchemaField[]): ApiSchemaField | undefined {
  const name = normalized(field).replace(/(?:hash|digest|checksum)$/, "");
  return targetFields.find((candidate) => normalized(candidate) === name)
    ?? targetFields.find((candidate) => isDocumentValue(candidate));
}

function conversionSteps(source: ApiSchemaField, target: ApiSchemaField): string[] {
  const description = target.description?.toLowerCase() ?? "";
  const steps = [source.path];
  if (/base64|encoded/.test(description) && !/base64/.test((source.description ?? "").toLowerCase()) && !/base64/.test(normalized(source))) {
    steps.push("Base64 encode");
  } else if (source.json_type !== target.json_type || source.format !== target.format) {
    steps.push("Convert representation");
  }
  steps.push(target.path);
  return steps;
}

/**
 * Explain whether a failed direct comparison still has a plausible connection
 * path. The rules intentionally never claim that an identifier can be
 * converted into a whole document: identifiers are lookup inputs, while a
 * hash/digest is derived from the document it describes.
 */
export function assessConnectionPotential(
  report: CheckReport,
  sourceFields: readonly ApiSchemaField[],
  targetFields: readonly ApiSchemaField[],
): ConnectionPotential {
  const semantics = report.check2.semantics;
  if (!semantics) {
    return {
      directLabel: "Not directly compatible",
      potentialLabel: "No known connection path",
      potentialKind: "incompatible",
      summary: "The schemas could not be compared, so a safe connection path cannot be proposed.",
      resolutions: [],
    };
  }

  const resolutions: ConnectionResolution[] = [];
  const unresolved = semantics.not_found.filter((field) => field.required);
  const sourceDocuments = sourceFields.filter(isDocumentValue);
  const sourceKeys = sourceFields.filter(isLookupKey);

  for (const item of unresolved) {
    const target = fieldForPath(targetFields, item.target_path);
    if (target && isDocumentValue(target) && sourceDocuments.length > 0) {
      const source = sourceDocuments[0];
      resolutions.push({
        targetPath: item.target_path,
        kind: "transformation",
        sourcePath: source.path,
        title: "Complete document available after conversion",
        detail: "The source already carries the complete business document; only its representation needs to change.",
        steps: conversionSteps(source, target),
      });
    } else if (target && isDocumentValue(target) && sourceKeys.length > 0) {
      const source = sourceKeys[0];
      resolutions.push({
        targetPath: item.target_path,
        kind: "enrichment",
        sourcePath: source.path,
        title: "External lookup and document construction required",
        detail: `${source.path} is a lookup key, not the target value. Retrieve the complete document before constructing and encoding ${item.target_path}.`,
        steps: [source.path, "External invoice lookup", "Construct target invoice", "Encode document", item.target_path],
      });
    } else {
      resolutions.push({
        targetPath: item.target_path,
        kind: "missing",
        sourcePath: null,
        title: "No known source or construction path",
        detail: "The required target value is not present and no safe way to produce it was identified.",
        steps: [item.target_path],
      });
    }
  }

  for (const target of targetFields.filter((field) => field.is_required && isDerivedDigest(field))) {
    if (resolutions.some((resolution) => resolution.targetPath === target.path)) continue;
    const dependency = digestDependency(target, targetFields);
    resolutions.push({
      targetPath: target.path,
      kind: "derived",
      sourcePath: dependency?.path ?? null,
      title: dependency ? `Derived after ${dependency.path} is available` : "Derived value requires its document",
      detail: dependency
        ? `Calculate ${target.path} from the completed ${dependency.path}; do not map an unrelated source field to it.`
        : `Calculate ${target.path} from the completed document once it is available.`,
      steps: [dependency?.path ?? "Completed document", "Calculate hash", target.path],
    });
  }

  const hasAmbiguousRequired = semantics.ambiguous.some((field) => field.required);
  const directLabel = unresolved.length > 0
    ? "Not directly compatible" as const
    : hasAmbiguousRequired
      ? "Decision required" as const
      : "Directly compatible" as const;
  const hasMissing = resolutions.some((resolution) => resolution.kind === "missing");
  const hasEnrichment = resolutions.some((resolution) => resolution.kind === "enrichment");
  const hasTransformation = resolutions.some((resolution) => resolution.kind === "transformation" || resolution.kind === "derived")
    || Boolean(report.check2.types?.conversions.some((conversion) => conversion.kind === "lossless" || conversion.kind === "conditional"));

  if (hasMissing) {
    return {
      directLabel,
      potentialLabel: "No known connection path",
      potentialKind: "incompatible",
      summary: "At least one required target value is missing and has no known source, derivation, or lookup path.",
      resolutions,
    };
  }
  if (hasEnrichment) {
    return {
      directLabel,
      potentialLabel: "Possible with external enrichment",
      potentialKind: "enrichment",
      summary: "This pair cannot connect by field mapping alone. An external lookup or additional API must supply missing business data.",
      resolutions,
    };
  }
  if (hasTransformation) {
    return {
      directLabel,
      potentialLabel: "Possible with transformation",
      potentialKind: "transformation",
      summary: "The required information is available, but the connection must transform or derive values before calling the target.",
      resolutions,
    };
  }
  return {
    directLabel,
    potentialLabel: "No additional steps required",
    potentialKind: "direct",
    summary: "The confirmed mappings can supply the target without an additional connection workflow.",
    resolutions,
  };
}
