export function cataloguePage<T>(records: readonly T[], requestedPage: number, pageSize = 12) {
  const size = Number.isFinite(pageSize) ? Math.max(1, Math.floor(pageSize)) : 12;
  const pages = Math.max(1, Math.ceil(records.length / size));
  const page = Number.isFinite(requestedPage) ? Math.min(pages, Math.max(1, Math.floor(requestedPage))) : 1;
  const start = (page - 1) * size;
  return { page, pages, items: records.slice(start, start + size), from: records.length ? start + 1 : 0, to: Math.min(start + size, records.length) };
}
