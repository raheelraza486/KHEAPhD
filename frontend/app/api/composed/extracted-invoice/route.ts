import { NextResponse } from "next/server";
import { APP_ROLES, requireRole } from "@/lib/auth";
import { convertExtractedInvoice } from "@/lib/composition/extracted-invoice";
import { InvoiceMappingError, type MappingOptions } from "@/lib/composition/invoice-mapping";
import { createAnswerLimiter, isSameOrigin, publicError } from "../../checks/shared";

export const dynamic = "force-dynamic";
const limit = createAnswerLimiter(60_000, 10);

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  if (!isSameOrigin(request)) return publicError("Cross-origin requests are not allowed.", 403, requestId);
  const gate = await requireRole(request, APP_ROLES, requestId);
  if ("response" in gate) return gate.response;
  const wait = limit(gate.user.id);
  if (wait > 0) return publicError("Too many invoices. Try again shortly.", 429, requestId, { retryAfterSeconds: wait });
  let body: { extraction: unknown; options?: MappingOptions };
  try {
    const raw = await request.text();
    if (raw.length > 500_000) return publicError("The request body is too large.", 413, requestId);
    body = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body) || !("extraction" in body)) return publicError("Expected { extraction, options? }.", 400, requestId);
  } catch { return publicError("The request body must be a JSON object.", 400, requestId); }
  try {
    const outcome = await convertExtractedInvoice(body.extraction, body.options);
    return NextResponse.json({ requestId, ...outcome }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof InvoiceMappingError) return publicError(error.message, error.code === "converter_unavailable" || error.code === "invalid_xml" ? 502 : 422, requestId, { reason: error.code });
    return publicError("The invoice could not be converted.", 500, requestId);
  }
}
