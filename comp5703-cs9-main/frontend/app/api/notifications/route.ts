import { NextResponse } from "next/server";
import { APP_ROLES, requireRole } from "@/lib/auth";
import { bearerTokenFromRequest } from "@/lib/auth-policy";
import type { ApiNotification } from "@/lib/notifications";
import { createSupabaseBearerClient, createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
const PAGE_SIZE = 20;
const FIELDS = "id,api_id,api_name,kind,created_at,read_at";
const LEGACY_FIELDS = "id,api_id,api_name,created_at,read_at";
type NotificationRow = Omit<ApiNotification, "kind"> & { kind?: ApiNotification["kind"] };
const SETTLEMENT_FIELDS = "id,source_api_id,target_api_id,source_api_name,target_api_name,target_path,option,chosen_source_path,created_at,read_at";
type SettlementRow = {
  id: string; source_api_id: string; target_api_id: string;
  source_api_name: string; target_api_name: string; target_path: string;
  option: "candidate" | "none" | "external"; chosen_source_path: string | null;
  created_at: string; read_at: string | null;
};

/**
 * Settlement notices (migration 0035) live in their own table because they are
 * about an ordered pair, not one API. The inbox reads both and shows one list;
 * a deployment without 0035 yet simply has no settlements to show, so a
 * missing table is not an error.
 */
function asNotification(row: SettlementRow): ApiNotification {
  return {
    id: row.id,
    api_id: row.target_api_id,
    api_name: row.target_api_name,
    kind: "conflict_settled",
    created_at: row.created_at,
    read_at: row.read_at,
    pair: {
      source_api_id: row.source_api_id,
      target_api_id: row.target_api_id,
      source_api_name: row.source_api_name,
      target_api_name: row.target_api_name,
      target_path: row.target_path,
      option: row.option,
      chosen_source_path: row.chosen_source_path,
    },
  };
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

async function sessionClient(request: Request) {
  const token = bearerTokenFromRequest(request);
  // Forward the user's session so database RLS also checks recipient ownership.
  return token ? createSupabaseBearerClient(token) : createSupabaseServerClient();
}

export async function GET(request: Request) {
  const access = await requireRole(request, APP_ROLES, crypto.randomUUID());
  if ("response" in access) return access.response;
  const offset = Number(new URL(request.url).searchParams.get("offset") ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) {
    return json({ error: "Invalid inbox page." }, 400);
  }
  try {
    const db = await sessionClient(request);
    const readPage = (fields: typeof FIELDS | typeof LEGACY_FIELDS) => db.from("api_notifications").select(fields)
        .eq("recipient_user_id", access.user.id)
        .order("created_at", { ascending: false }).order("id", { ascending: false })
        .range(offset, offset + PAGE_SIZE).returns<NotificationRow[]>();
    const readSettlements = () => db.from("check_notification").select(SETTLEMENT_FIELDS)
      .eq("recipient_user_id", access.user.id)
      .order("created_at", { ascending: false }).order("id", { ascending: false })
      .range(offset, offset + PAGE_SIZE).returns<SettlementRow[]>();
    let [page, unread, settlements, settlementsUnread] = await Promise.all([
      readPage(FIELDS),
      db.from("api_notifications").select("id", { count: "exact", head: true })
        .eq("recipient_user_id", access.user.id).is("read_at", null),
      readSettlements(),
      db.from("check_notification").select("id", { count: "exact", head: true })
        .eq("recipient_user_id", access.user.id).is("read_at", null),
    ]);
    // Preserve the existing inbox while migration 0017 is being deployed.
    // Only the known missing column permits a fallback; other failures stay errors.
    const legacyNotifications = page.error?.code === "42703" && /\bkind\b/.test(page.error.message);
    if (legacyNotifications) page = await readPage(LEGACY_FIELDS);
    if (page.error || unread.error) throw new Error("Inbox read failed");
    // Before migration 0035 there is no settlements table; that is not a failure.
    const settlementsAvailable = !settlements.error;
    const rows = page.data ?? [];
    const merged = [
      ...rows.map((row) => legacyNotifications ? { ...row, kind: "api_verified" as const } : row as ApiNotification),
      ...(settlementsAvailable ? (settlements.data ?? []).map(asNotification) : []),
    ].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
    const more = rows.length > PAGE_SIZE || (settlements.data ?? []).length > PAGE_SIZE;
    return json({
      notifications: merged.slice(0, PAGE_SIZE),
      unread_count: (unread.count ?? 0) + (settlementsAvailable ? settlementsUnread.count ?? 0 : 0),
      next_offset: more ? offset + PAGE_SIZE : null,
      submission_notifications_available: !legacyNotifications,
    });
  } catch {
    return json({ error: "Your inbox is temporarily unavailable. Please try again." }, 503);
  }
}

export async function PATCH(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || request.headers.get("host");
  try {
    if (!origin || !host || new URL(origin).host.toLowerCase() !== host.toLowerCase()) throw new Error();
  } catch {
    return json({ error: "Updates must come from this website." }, 403);
  }
  const access = await requireRole(request, APP_ROLES, crypto.randomUUID());
  if ("response" in access) return access.response;
  const body = await request.text();
  if (new TextEncoder().encode(body).length > 1_024) return json({ error: "Request body is too large." }, 413);
  let input: { id?: unknown; action?: unknown };
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    input = parsed;
  } catch { return json({ error: "Invalid JSON." }, 400); }
  const id = input.id;
  const markAllRead = input.action === "mark_all_read";
  if (input.action !== undefined && !markAllRead) return json({ error: "Invalid inbox action." }, 400);
  if (!markAllRead && (typeof id !== "string" || !UUID.test(id))) return json({ error: "Invalid notification id." }, 400);
  try {
    const db = await sessionClient(request);
    const now = new Date().toISOString();
    const markAllIn = (table: "api_notifications" | "check_notification") =>
      db.from(table).update({ read_at: now })
        .eq("recipient_user_id", access.user.id).is("read_at", null).select("id");
    if (markAllRead) {
      const [updated, settled] = await Promise.all([markAllIn("api_notifications"), markAllIn("check_notification")]);
      if (updated.error) throw new Error("Inbox update failed");
      return json({ ok: true, updated_count: (updated.data?.length ?? 0) + (settled.error ? 0 : settled.data?.length ?? 0) });
    }
    // The id belongs to one of the two tables; neither knowing which nor
    // finding it in the first is an error.
    const markOneIn = (table: "api_notifications" | "check_notification") =>
      db.from(table).update({ read_at: now })
        .eq("recipient_user_id", access.user.id).eq("id", id as string).is("read_at", null).select("id");
    const updated = await markOneIn("api_notifications");
    if (updated.error) throw new Error("Inbox update failed");
    if (!updated.data?.length) {
      const settled = await markOneIn("check_notification");
      if (!settled.error && settled.data?.length) return json({ ok: true });
      const existing = await db.from("api_notifications").select("id")
        .eq("recipient_user_id", access.user.id).eq("id", id as string).maybeSingle();
      if (existing.error) throw new Error("Inbox read failed");
      if (!existing.data) {
        const settledExisting = await db.from("check_notification").select("id")
          .eq("recipient_user_id", access.user.id).eq("id", id as string).maybeSingle();
        if (settledExisting.error || !settledExisting.data) return json({ error: "Notification was not found." }, 404);
      }
    }
    return json({ ok: true });
  } catch {
    return json({ error: "Could not mark the notification as read. Please try again." }, 503);
  }
}
