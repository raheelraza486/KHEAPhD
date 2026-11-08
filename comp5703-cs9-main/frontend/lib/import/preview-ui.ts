export type PreviewCandidateState = "none" | "all_existing" | "has_new";

type PreviewCandidate = { predicted_outcome: string };

export function isNewPreviewCandidate(candidate: PreviewCandidate): boolean {
  return candidate.predicted_outcome === "insert";
}

export function selectablePreviewIndexes(
  candidates: ReadonlyArray<PreviewCandidate & { index: number }>,
): number[] {
  return candidates.filter(isNewPreviewCandidate).map((candidate) => candidate.index);
}

export function isSupportedDocumentUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function classifyPreviewCandidates(
  candidates: ReadonlyArray<PreviewCandidate>,
): PreviewCandidateState {
  if (candidates.length === 0) return "none";
  return candidates.some(isNewPreviewCandidate) ? "has_new" : "all_existing";
}

export function isUnreadableDocumentResponse(status: number): boolean {
  return status === 422;
}
