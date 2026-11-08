/**
 * Field-name normalisation. Two names are "the same" for the engine when
 * they agree after lowercasing, dropping punctuation and singularising.
 */

const NON_ALNUM = /[^a-z0-9]/g;
const CAMEL_BOUNDARY = /([a-z0-9])([A-Z])/g;
const TOKEN_SPLIT = /[^A-Za-z0-9]+|\s+/;

/**
 * "Line_Items" -> "lineitem", "customerId" -> "customerid", "bus" -> "bus".
 * A trailing "s" is only dropped when the cleaned word is longer than three
 * characters, so short words such as "bus" or "ids" are left alone.
 */
export function normalizeName(value: string): string {
  let cleaned = value.toLowerCase().replace(NON_ALNUM, "");
  if (cleaned.length > 3 && cleaned.endsWith("s")) {
    cleaned = cleaned.slice(0, -1);
  }
  return cleaned;
}

/**
 * Split a name into normalised tokens: "invoiceDate" -> {"invoice", "date"},
 * "line_items" -> {"line", "item"}. Falls back to the whole normalised name
 * when nothing survives the split.
 */
export function tokenizeName(value: string): Set<string> {
  const spaced = value.replace(CAMEL_BOUNDARY, "$1 $2");
  const tokens = new Set<string>();
  for (const piece of spaced.split(TOKEN_SPLIT)) {
    const norm = normalizeName(piece);
    if (norm) tokens.add(norm);
  }
  if (tokens.size === 0) {
    const joined = normalizeName(value);
    if (joined) tokens.add(joined);
  }
  return tokens;
}
