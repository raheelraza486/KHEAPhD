// The compatibility check of one ordered pair (Compatibility Check Manual
// v1.0, chapter 9). The page calls this and renders the report; it never
// reads the tables itself (they are closed to the browser roles).
//
//   GET /api/checks?source_id=<uuid>&target_id=<uuid>[&format=<canonical>]
//
// `format` is the canonical format the page is comparing in (§6.4). Omitted,
// Check 1 picks the default; a format neither side offers is refused with 400.
//
// The answer carries `report` (lib/checks/types.ts: CheckReport) — every
// check's result, the overall verdict, and, when the verdict is
// pending_user / pending_admin, the fields waiting for an answer.
import { NextResponse } from "next/server";
import { getCurrentAppUser } from "@/lib/auth";
import { getSupabaseConfig, publicError, reportFor, UUID } from "./shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requestId = crypto.randomUUID();
  const params = new URL(request.url).searchParams;
  const sourceId = (params.get("source_id") ?? "").trim();
  const targetId = (params.get("target_id") ?? "").trim();
  if (!UUID.test(sourceId) || !UUID.test(targetId)) return publicError("source_id and target_id must be UUIDs.", 400, requestId);
  if (sourceId === targetId) return publicError("source_id and target_id must differ.", 400, requestId);
  const format = (params.get("format") ?? "").trim();
  if (format.length > 100) return publicError("format is not a known format name.", 400, requestId);
  const config = getSupabaseConfig();
  if (!config) return publicError("The database is not configured.", 503, requestId);
  const sourceSchemaId = (params.get("source_schema_id") ?? "").trim();
  const targetSchemaId = (params.get("target_schema_id") ?? "").trim();
  if (sourceSchemaId && !UUID.test(sourceSchemaId)) {
    return publicError( "source_schema_id must be a UUID.", 400, requestId,);
  }
  if (targetSchemaId && !UUID.test(targetSchemaId)) {
  return publicError(
    "target_schema_id must be a UUID.",
    400,
    requestId,
  );
}
  // Saved answers belong to the people who gave them; a visitor gets the
  // check's own result. An unreachable auth service is treated as signed out,
  // which shows less rather than more.
  const signedIn = await getCurrentAppUser(request).then((user) => user !== null).catch(() => false);
  const outcome = await reportFor(config, sourceId, targetId, requestId, format || null, signedIn, { sourceSchemaId: sourceSchemaId || null, targetSchemaId: targetSchemaId || null },);
  if (!outcome.ok) return outcome.response;
  return NextResponse.json({ report: outcome.report, requestId }, { headers: { "Cache-Control": "no-store" } });
}
