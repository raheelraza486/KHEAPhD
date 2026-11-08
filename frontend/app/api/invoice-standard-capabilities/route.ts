/** API-only claim and review workflow; no submission-page changes required. */
import { NextResponse } from "next/server";
import { ADMIN_ROLES, SUBMITTER_ROLES, requireRole } from "@/lib/auth";
import { bearerTokenFromRequest, canManageApi } from "@/lib/auth-policy";
import { getSupabaseConfig, type SupabaseConfig } from "@/lib/checks/store";

export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function headers(config: SupabaseConfig, write = false): Record<string, string> {
  const result: Record<string, string> = { apikey: config.key, Accept: "application/json" };
  if (!config.opaqueSecret) result.Authorization = `Bearer ${config.key}`;
  if (write) { result["Content-Type"] = "application/json"; result.Prefer = "return=representation"; }
  return result;
}

function reply(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

function sameOriginOrBearer(request: Request) {
  if (bearerTokenFromRequest(request)) return true;
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || request.headers.get("host");
  if (!origin || !host) return false;
  try { return new URL(origin).host.toLowerCase() === host.toLowerCase(); } catch { return false; }
}

async function body(request: Request): Promise<Record<string, unknown> | null> {
  const raw = await request.text();
  if (raw.length > 10_000) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

function value(input: Record<string, unknown>, key: string, maximum: number): string | null {
  const candidate = input[key];
  if (candidate === undefined || candidate === null) return "";
  if (typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  return trimmed.length <= maximum ? trimmed : null;
}

function httpUrl(input: string) {
  if (!input) return true;
  try { const url = new URL(input); return url.protocol === "http:" || url.protocol === "https:"; }
  catch { return false; }
}

async function ownedApi(config: SupabaseConfig, apiId: string) {
  const query = new URLSearchParams({ select: "id,created_by_user,is_active,duplicate_of", id: `eq.${apiId}`, limit: "1" });
  const response = await fetch(`${config.url}/rest/v1/apis?${query}`, { headers: headers(config), cache: "no-store" });
  if (!response.ok) throw new Error(`API read failed ${response.status}`);
  const rows = await response.json() as Array<{ id: string; created_by_user: string | null; is_active: boolean; duplicate_of: string | null }>;
  return rows.find((row) => row.is_active && !row.duplicate_of) ?? null;
}

/** Read claims and review state for one owned operation. */
export async function GET(request: Request) {
  const access = await requireRole(request, SUBMITTER_ROLES, crypto.randomUUID());
  if ("response" in access) return access.response;
  const apiId = new URL(request.url).searchParams.get("api_id") ?? "";
  if (!UUID.test(apiId)) return reply("A valid API ID is required.", 400);
  const config = getSupabaseConfig();
  if (!config) return reply("The database is not configured.", 503);
  try {
    const api = await ownedApi(config, apiId);
    if (!api) return reply("Active API not found.", 404);
    if (!canManageApi(access.user, api)) return reply("You cannot inspect claims for this API.", 403);
    const query = new URLSearchParams({
      select: "id,api_id,direction,standard,version,profile,condition,status,evidence_url,evidence_note,submitted_by,reviewed_by,reviewed_at,created_at",
      api_id: `eq.${apiId}`, order: "created_at.desc", limit: "500",
    });
    const response = await fetch(`${config.url}/rest/v1/api_invoice_standard_capability?${query}`, {
      headers: headers(config), cache: "no-store",
    });
    if (!response.ok) throw new Error(`Capability read failed ${response.status}`);
    return NextResponse.json({ capabilities: await response.json() }, { headers: { "Cache-Control": "no-store" } });
  } catch { return reply("Standard claims could not be loaded.", 502); }
}

/** A publisher can report capabilities only for an API they own; an admin can report any. */
export async function POST(request: Request) {
  const access = await requireRole(request, SUBMITTER_ROLES, crypto.randomUUID());
  if ("response" in access) return access.response;
  if (!sameOriginOrBearer(request)) return reply("A same-origin request or bearer token is required.", 403);
  const input = await body(request);
  if (!input) return reply("A small JSON object is required.", 400);
  const apiId = value(input, "api_id", 36);
  const direction = value(input, "direction", 6);
  const standard = value(input, "standard", 120);
  const version = value(input, "version", 80);
  const profile = value(input, "profile", 120);
  const condition = value(input, "condition", 500);
  const evidenceUrl = value(input, "evidence_url", 2000);
  const evidenceNote = value(input, "evidence_note", 2000);
  if (!apiId || !UUID.test(apiId) || (direction !== "input" && direction !== "output")
    || !standard || standard.length < 2 || !version || !/\d/.test(version)
    || profile === null || condition === null || evidenceUrl === null || !httpUrl(evidenceUrl) || evidenceNote === null) {
    return reply("An API ID, direction, standard and specific version are required; evidence URL must be HTTP(S).", 400);
  }
  const config = getSupabaseConfig();
  if (!config) return reply("The database is not configured.", 503);
  try {
    const api = await ownedApi(config, apiId);
    if (!api) return reply("Active API not found.", 404);
    if (!canManageApi(access.user, api)) return reply("You cannot submit claims for this API.", 403);
    const response = await fetch(`${config.url}/rest/v1/api_invoice_standard_capability`, {
      method: "POST", headers: headers(config, true), cache: "no-store",
      body: JSON.stringify({
        api_id: apiId, direction, standard, version, profile, condition, status: "reported",
        evidence_url: evidenceUrl, evidence_note: evidenceNote, submitted_by: access.user.id,
      }),
    });
    if (!response.ok) throw new Error(`Capability write failed ${response.status}`);
    const rows = await response.json();
    return NextResponse.json({ capability: rows[0], usable_for_matching: false }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch { return reply("The standard claim could not be saved.", 502); }
}

/** Admin confirmation needs an evidence URL supplied at review time. */
export async function PATCH(request: Request) {
  const access = await requireRole(request, ADMIN_ROLES, crypto.randomUUID());
  if ("response" in access) return access.response;
  if (!sameOriginOrBearer(request)) return reply("A same-origin request or bearer token is required.", 403);
  const input = await body(request);
  if (!input) return reply("A small JSON object is required.", 400);
  const id = value(input, "id", 36);
  const decision = value(input, "decision", 9);
  const evidenceUrl = value(input, "evidence_url", 2000);
  const evidenceNote = value(input, "evidence_note", 2000);
  if (!id || !UUID.test(id) || (decision !== "confirmed" && decision !== "rejected")
    || evidenceUrl === null || evidenceNote === null
    || (decision === "confirmed" && (!evidenceUrl || !httpUrl(evidenceUrl)))
    || (decision === "rejected" && !evidenceNote)) {
    return reply("Review requires a valid claim ID, decision and documented evidence or rejection note.", 400);
  }
  const config = getSupabaseConfig();
  if (!config) return reply("The database is not configured.", 503);
  try {
    const query = new URLSearchParams({ id: `eq.${id}`, status: "eq.reported", select: "*" });
    const response = await fetch(`${config.url}/rest/v1/api_invoice_standard_capability?${query}`, {
      method: "PATCH", headers: headers(config, true), cache: "no-store",
      body: JSON.stringify({
        status: decision, evidence_url: evidenceUrl || "", evidence_note: evidenceNote,
        reviewed_by: access.user.id, reviewed_at: new Date().toISOString(),
      }),
    });
    if (!response.ok) throw new Error(`Capability review failed ${response.status}`);
    const rows = await response.json() as unknown[];
    if (!rows.length) return reply("An unreviewed claim was not found.", 404);
    return NextResponse.json({ capability: rows[0], usable_for_matching: decision === "confirmed" }, { headers: { "Cache-Control": "no-store" } });
  } catch { return reply("The standard claim could not be reviewed.", 502); }
}
