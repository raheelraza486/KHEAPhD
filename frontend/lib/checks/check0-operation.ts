/**
 * Check 0 · operation logic.
 *
 * Client direction, 16 September 2026:
 * Transformation → Validation → Communication.
 *
 * - two Transformations in a row are allowed (client, 3 and 10 October 2026:
 *   extraction then conversion); a Validation after a Validation, or a
 *   Communication after a Communication, is not (decided 7 October 2026,
 *   applied 14 October 2026; to be revisited if the client asks for it);
 * - moving one stage forward is allowed;
 * - Transformation straight to Communication skips Validation, which the
 *   client ruled out on 1 October 2026; it passes only when a Validation step
 *   of the same process stands between the two (`validatedBetween`);
 * - moving backward is incompatible;
 * - Other, missing, or unrecognised categories cannot be determined.
 */
import type { Check0Result, PairInput } from "./types.ts";

export const OPERATION_SEQUENCE = [
  "Transformation",
  "Validation",
  "Communication",
] as const;

type SupportedCategory = (typeof OPERATION_SEQUENCE)[number];

function supportedCategory(
  value: string | null | undefined,
): SupportedCategory | null {
  const normalised = value?.trim().toLowerCase();

  return (
    OPERATION_SEQUENCE.find(
      (category) => category.toLowerCase() === normalised,
    ) ?? null
  );
}

export function runCheck0(input: PairInput): Check0Result {
  const sourceCategoryRaw = input.source.api.category?.trim() || null;
  const targetCategoryRaw = input.target.api.category?.trim() || null;

  const sourceCategory = supportedCategory(sourceCategoryRaw);
  const targetCategory = supportedCategory(targetCategoryRaw);

  if (!sourceCategory || !targetCategory) {
    return {
      status: "unknown",
      reason_code: "operation_category_unknown",
      source_category: sourceCategoryRaw,
      target_category: targetCategoryRaw,
      sequence: [...OPERATION_SEQUENCE],
      flags: [],
    };
  }

  const sourceIndex = OPERATION_SEQUENCE.indexOf(sourceCategory);
  const targetIndex = OPERATION_SEQUENCE.indexOf(targetCategory);

  if (sourceIndex > targetIndex) {
    return {
      status: "fail",
      reason_code: "operation_sequence_reversed",
      source_category: sourceCategory,
      target_category: targetCategory,
      sequence: [...OPERATION_SEQUENCE],
      flags: [],
    };
  }

  if (sourceIndex === targetIndex && sourceCategory !== "Transformation") {
    return {
      status: "fail",
      reason_code: "operation_sequence_repeats_stage",
      source_category: sourceCategory,
      target_category: targetCategory,
      sequence: [...OPERATION_SEQUENCE],
      flags: [],
    };
  }

  const skipsValidation = targetIndex - sourceIndex > 1;

  if (skipsValidation && !input.validatedBetween) {
    return {
      status: "fail",
      reason_code: "operation_sequence_skips_validation",
      source_category: sourceCategory,
      target_category: targetCategory,
      sequence: [...OPERATION_SEQUENCE],
      flags: [],
    };
  }

  const flags: Check0Result["flags"] = [];

  if (sourceIndex === targetIndex) {
    flags.push("same_operation_category");
  } else if (skipsValidation) {
    flags.push("validated_in_between");
  }

  return {
    status: "pass",
    reason_code: null,
    source_category: sourceCategory,
    target_category: targetCategory,
    sequence: [...OPERATION_SEQUENCE],
    flags,
  };
}