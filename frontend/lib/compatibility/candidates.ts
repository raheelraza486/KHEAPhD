import type { NormalizedNode, SchemaEntry } from "./types.ts";
import { normalizeName, tokenizeName } from "./name.ts";
import { sequenceRatio } from "./sequence-ratio.ts";
import { primitiveRelation } from "./relation.ts";

export interface CandidateMatch {
  entry: SchemaEntry;
  /** 0 = same name + direct type ... 5 = string similarity alone. */
  tier: number;
  /**
   * How many entries tied at `tier`, this one included. 1 means nothing else
   * qualified; more means the winner was chosen by path length and then source
   * order, and the caller is the only place that can say so.
   */
  alternatives: number;
}

interface RankedCandidate {
  tier: number;
  pathLength: number;
  entry: SchemaEntry;
}

/**
 * Rank every unused source entry as a candidate for one target field.
 *
 * Tiers, checked in order (first hit wins for that entry):
 *   0  same normalised name, type relation direct
 *   1  same normalised name, type relation mapping (castable)
 *   2  token sets: one side contains the other, relation direct
 *   3  token subset, relation mapping
 *   4  any shared token AND difflib ratio >= 0.55, relation direct/mapping
 *   5  difflib ratio >= 0.88 regardless of tokens, relation direct/mapping
 * Entries whose type relation is "incompatible" never qualify, whatever the name.
 */
export function rankMappingCandidates(
  targetKey: string,
  targetNode: NormalizedNode,
  sourceIndex: SchemaEntry[],
  usedPaths: Set<string>,
): RankedCandidate[] {
  const targetNorm = normalizeName(targetKey);
  const targetTokens = tokenizeName(targetKey);
  const compatible: RankedCandidate[] = [];

  for (const entry of sourceIndex) {
    if (usedPaths.has(entry.path) || entry.path === "$") continue;

    const similarity = sequenceRatio(targetNorm, entry.leafNorm);
    const relation = primitiveRelation(entry.node, targetNode);
    const sameLeaf = targetNorm !== "" && targetNorm === entry.leafNorm;
    const sourceTokens = tokenizeName(entry.leaf);
    const tokenOverlap = [...targetTokens].some((t) => sourceTokens.has(t));
    const subsetMatch =
      targetTokens.size > 0 &&
      (containsAll(sourceTokens, targetTokens) || containsAll(targetTokens, sourceTokens));
    const castable = relation === "direct" || relation === "mapping";

    let tier: number | null = null;
    if (sameLeaf && relation === "direct") tier = 0;
    else if (sameLeaf && relation === "mapping") tier = 1;
    else if (subsetMatch && relation === "direct") tier = 2;
    else if (subsetMatch && relation === "mapping") tier = 3;
    else if (tokenOverlap && similarity >= 0.55 && castable) tier = 4;
    else if (similarity >= 0.88 && castable) tier = 5;

    if (tier !== null) {
      compatible.push({ tier, pathLength: entry.path.length, entry });
    }
  }

  // Lower tier first; within a tier prefer the shorter (shallower) path.
  // Array.prototype.sort is stable, so equal keys keep source-index order.
  compatible.sort((a, b) => a.tier - b.tier || a.pathLength - b.pathLength);
  return compatible;
}

export function findMappingCandidateWithTier(
  targetKey: string,
  targetNode: NormalizedNode,
  sourceIndex: SchemaEntry[],
  usedPaths: Set<string>,
): CandidateMatch | null {
  const ranked = rankMappingCandidates(targetKey, targetNode, sourceIndex, usedPaths);
  if (ranked.length === 0) return null;
  const best = ranked[0];
  // Counted here, after usedPaths has removed whatever an earlier target field
  // already claimed, so it is the ambiguity that existed at the moment of this
  // choice rather than in the source schema as a whole.
  const alternatives = ranked.filter((candidate) => candidate.tier === best.tier).length;
  return { entry: best.entry, tier: best.tier, alternatives };
}

function containsAll(outer: Set<string>, inner: Set<string>): boolean {
  for (const t of inner) if (!outer.has(t)) return false;
  return true;
}
