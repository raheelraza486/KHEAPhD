import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { extractSchemaChoices } from "@/lib/compatibility/schema-file";
import { loadSchemaDocument } from "@/lib/schema/document-loader";
import { checkMutationRateLimit } from "@/lib/mutation-rate-limit";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 4_000;

function publicError(error: string, status: number, requestId: string) {
  return NextResponse.json({ error, requestId }, { status, headers: { "Cache-Control": "no-store" } });
}

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || request.headers.get("host")?.trim();
  if (!origin || !host) return false;
  try { return new URL(origin).host.toLowerCase() === host.toLowerCase(); }
  catch { return false; }
}

function clientKey(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

export async function POST(request: Request) {
  const requestId = randomUUID();
  if (!isSameOrigin(request)) return publicError("Cross-origin requests are not allowed.", 403, requestId);

  const retryAfter = checkMutationRateLimit("import", { id: "compatibility-preview", role: "viewer" }, `compatibility:${clientKey(request)}`);
  if (retryAfter) {
    return NextResponse.json(
      { error: "Too many links were checked. Please wait before trying again.", requestId },
      { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(retryAfter) } },
    );
  }

  let input: { url?: unknown; side?: unknown };
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return publicError("The request is too large.", 413, requestId);
    input = JSON.parse(raw) as { url?: unknown; side?: unknown };
  } catch {
    return publicError("Send a valid API link.", 400, requestId);
  }

  const url = typeof input.url === "string" ? input.url.trim() : "";
  const side = input.side === "source" || input.side === "target" ? input.side : null;
  if (!url || url.length > 2_048 || !side) return publicError("Send a valid API link and comparison side.", 400, requestId);

  const loaded = await loadSchemaDocument(url);
  if (!loaded.ok) return publicError(loaded.message, 422, requestId);

  try {
    const choices = extractSchemaChoices(loaded.document, side);
    return NextResponse.json(
      { choices, sourceUrl: loaded.final_url, requestId },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return publicError("The link does not contain a usable OpenAPI response or request definition for this side.", 422, requestId);
  }
}
