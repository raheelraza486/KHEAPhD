/**
 * Python difflib.SequenceMatcher.ratio() (Ratcliff/Obershelp), without the
 * autojunk heuristic. autojunk only applies to strings of 200+ characters,
 * far longer than any field name we compare, so leaving it out changes
 * nothing for our inputs.
 *
 * Do not replace this with Levenshtein or another "close enough" measure:
 * the candidate tiers in candidates.ts are calibrated against difflib's
 * exact behaviour (thresholds 0.55 and 0.88).
 */
export function sequenceRatio(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  if (la + lb === 0) return 1.0;

  const b2j = new Map<string, number[]>();
  for (let j = 0; j < lb; j++) {
    const ch = b[j];
    const list = b2j.get(ch);
    if (list) list.push(j);
    else b2j.set(ch, [j]);
  }

  let matches = 0;
  const stack: Array<[number, number, number, number]> = [[0, la, 0, lb]];
  while (stack.length > 0) {
    const [alo, ahi, blo, bhi] = stack.pop()!;
    const [i, j, k] = findLongestMatch(a, b2j, alo, ahi, blo, bhi);
    if (k > 0) {
      matches += k;
      if (alo < i && blo < j) stack.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) stack.push([i + k, ahi, j + k, bhi]);
    }
  }
  return (2.0 * matches) / (la + lb);
}

function findLongestMatch(
  a: string,
  b2j: Map<string, number[]>,
  alo: number,
  ahi: number,
  blo: number,
  bhi: number,
): [number, number, number] {
  let besti = alo;
  let bestj = blo;
  let bestsize = 0;
  let j2len = new Map<number, number>();
  for (let i = alo; i < ahi; i++) {
    const newJ2len = new Map<number, number>();
    const indices = b2j.get(a[i]);
    if (indices) {
      for (const j of indices) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        newJ2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
    }
    j2len = newJ2len;
  }
  return [besti, bestj, bestsize];
}
