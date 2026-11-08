import "server-only";

import { NextResponse } from "next/server";
import {
  authenticatedUserFromProfile,
  bearerTokenFromRequest,
  hasAllowedRole,
  type AppRole,
  type AppUserProfile,
  type AuthenticatedAppUser,
} from "@/lib/auth-policy";
import {
  createSupabaseBearerClient,
  createSupabaseServerClient,
  SupabaseAuthConfigurationError,
} from "@/lib/supabase/server";

export type { AppRole, AuthenticatedAppUser } from "@/lib/auth-policy";
export { ADMIN_ROLES, APP_ROLES, SUBMITTER_ROLES } from "@/lib/auth-policy";

export class AuthServiceUnavailableError extends Error {}

/**
 * Resolve a verified Supabase identity to the application's active role row.
 * Roles are never read from user-editable metadata or a request body.
 */
export async function getCurrentAppUser(request?: Request): Promise<AuthenticatedAppUser | null> {
  try {
    const token = bearerTokenFromRequest(request);
    const supabase = token
      ? createSupabaseBearerClient(token)
      : await createSupabaseServerClient();
    // getClaims verifies the signed JWT locally when the project uses asymmetric
    // keys, avoiding an Auth-server round trip on every protected request. Older
    // symmetric projects are handled by the client's authenticated fallback.
    const { data: identityData, error: identityError } = await supabase.auth.getClaims(token ?? undefined);
    const claims = identityData?.claims;
    const userId = claims?.sub;

    if (identityError || typeof userId !== "string" || userId.length === 0) return null;

    const { data: profile, error: profileError } = await supabase
      .from("app_user")
      .select("id,email,display_name,role,is_active")
      .eq("id", userId)
      .maybeSingle();

    if (profileError) {
      throw new AuthServiceUnavailableError("The signed-in user's role could not be loaded.");
    }

    return authenticatedUserFromProfile(
      {
        id: userId,
        email: typeof claims?.email === "string" ? claims.email : undefined,
      },
      profile as AppUserProfile | null,
    );
  } catch (error) {
    if (error instanceof SupabaseAuthConfigurationError || error instanceof AuthServiceUnavailableError) {
      throw error;
    }
    throw new AuthServiceUnavailableError("Supabase Auth could not be reached.");
  }
}

type GrantedRole = { user: AuthenticatedAppUser; response?: never };
type RefusedRole = { user?: never; response: NextResponse };

export async function requireRole(
  request: Request,
  allowedRoles: readonly AppRole[],
  requestId: string,
): Promise<GrantedRole | RefusedRole> {
  let user: AuthenticatedAppUser | null;
  try {
    user = await getCurrentAppUser(request);
  } catch {
    return {
      response: NextResponse.json(
        { error: "Sign-in is temporarily unavailable. Please try again.", requestId },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      ),
    };
  }

  if (!user) {
    return {
      response: NextResponse.json(
        { error: "Sign in to continue.", requestId },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      ),
    };
  }
  if (!hasAllowedRole(user.role, allowedRoles)) {
    return {
      response: NextResponse.json(
        { error: "Your account does not have permission to do this.", requestId },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      ),
    };
  }
  return { user };
}
