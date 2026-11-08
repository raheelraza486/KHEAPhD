/** Python repr()/str() formatting, so enum messages match the upstream output. */

function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}

export function pyReprList(values: unknown[]): string {
  return `[${values.map(pyRepr).join(", ")}]`;
}

export function sortedByStr(values: Set<unknown>): unknown[] {
  return [...values].sort((a, b) => {
    const sa = String(a);
    const sb = String(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
}
