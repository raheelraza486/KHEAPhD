// Backfill needs every server an OpenAPI operation declares: the old catalogue
// can contain the second server (IRIS Portal), while import previews use only
// the first. No API calls or document mutation happen here.

import { operationKey } from "../import/session-candidates.ts";
import type { Candidate } from "../import/types.ts";
import { parseOpenApi3, swaggerBase } from "../openapi/parse.ts";
import { isObject, resolveRef, text, type JsonObject } from "../openapi/ref.ts";

function serverBase(server: unknown, sourceUrl: string): string | null {
  if (!isObject(server) || !text(server.url)) return null;
  const variables = isObject(server.variables) ? server.variables : {};
  let unresolved = false;
  const raw = text(server.url).replace(/\{([^{}]+)\}/g, (token, name: string) => {
    const variable = variables[name];
    if (isObject(variable) && typeof variable.default === "string") return variable.default;
    unresolved = true;
    return token;
  });
  if (unresolved) return null;
  try {
    const url = new URL(raw, sourceUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.search || url.hash) return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

/**
 * Expand each operation's effective servers (operation > path > document),
 * preserving its method and schema key. An omitted/empty root servers array
 * means '/' under OAS 3.0.3 §4.7.1.1, resolved against the fetched spec URL.
 * https://spec.openapis.org/oas/v3.0.3.html#openapi-object
 *
 * Only declared server-variable defaults are substituted. Missing defaults,
 * invalid URLs and empty override arrays produce no matchable endpoint.
 */
export function buildSchemaCandidates(document: unknown, sourceUrl: string): Candidate[] {
  const parsed = parseOpenApi3(document, sourceUrl);
  // parseOpenApi3 has already validated this object and its OpenAPI version.
  const root = document as JsonObject;
  const isSwagger2 = typeof root.swagger === "string" && root.swagger.trim().startsWith("2");
  const paths = isObject(root.paths) ? root.paths : {};
  const out = new Map<string, Candidate>();

  for (const candidate of parsed.candidates) {
    const path = candidate.operation_path;
    if (!path) continue;
    const item = resolveRef(paths[path], root, []);
    if (!isObject(item)) continue;
    const operation = item[candidate.http_method.toLowerCase()];
    if (!isObject(operation)) continue;

    const hasOverride = Array.isArray(operation.servers) || Array.isArray(item.servers);
    // A Swagger 2.0 document has no `servers`: its base is schemes + host +
    // basePath. Without this the OpenAPI default '/' applies and every endpoint
    // loses the basePath -- Storecove's /api/v2 -- so no record matches.
    const swagger2 = isSwagger2 ? [{ url: swaggerBase(root, sourceUrl, []) }] : [];
    const declared = Array.isArray(operation.servers) ? operation.servers
      : Array.isArray(item.servers) ? item.servers
        : Array.isArray(root.servers) ? root.servers
          : swagger2;
    const useDefault = !hasOverride && declared.length === 0;
    const servers = useDefault ? [{ url: "/" }] : declared;
    for (const server of servers) {
      const base = serverBase(server, sourceUrl);
      if (!base) continue;
      const expanded: Candidate = {
        ...candidate,
        api_endpoint: `${base}${path.startsWith("/") ? "" : "/"}${path}`,
        data_quality: candidate.data_quality === "unreachable_documentation"
          ? "unreachable_documentation" : "ok",
        warnings: useDefault
          ? [...candidate.warnings, "servers is absent or empty; using the OpenAPI default '/' at the document origin"]
          : [...candidate.warnings],
      };
      out.set(operationKey(expanded), expanded);
    }
  }
  return [...out.values()];
}
