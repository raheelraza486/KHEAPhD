export const APP_ROLES = ["viewer", "publisher", "admin"] as const;

export type AppRole = (typeof APP_ROLES)[number];

export type AuthenticatedAppUser = {
  id: string;
  email: string;
  displayName: string;
  role: AppRole;
};

export type AppUserProfile = {
  id?: unknown;
  email?: unknown;
  display_name?: unknown;
  role?: unknown;
  is_active?: unknown;
};

export const SUBMITTER_ROLES = ["publisher", "admin"] as const satisfies readonly AppRole[];
export const ADMIN_ROLES = ["admin"] as const satisfies readonly AppRole[];

export function isAppRole(value: unknown): value is AppRole {
  return typeof value === "string" && APP_ROLES.includes(value as AppRole);
}

export function bearerTokenFromRequest(request?: Request): string | null {
  if (!request) return null;
  const value = request.headers.get("authorization")?.trim() ?? "";
  const match = /^Bearer\s+([^\s]+)$/i.exec(value);
  return match?.[1] ?? null;
}

export function authenticatedUserFromProfile(
  authIdentity: { id: string; email?: string | null },
  profile: AppUserProfile | null,
): AuthenticatedAppUser | null {
  if (
    !profile
    || profile.id !== authIdentity.id
    || profile.is_active !== true
    || !isAppRole(profile.role)
  ) {
    return null;
  }

  const profileEmail = typeof profile.email === "string" ? profile.email.trim() : "";
  const identityEmail = authIdentity.email?.trim() ?? "";
  const email = profileEmail || identityEmail;
  const suppliedName = typeof profile.display_name === "string" ? profile.display_name.trim() : "";
  const displayName = (suppliedName || email || "Authenticated user").slice(0, 120);

  return {
    id: authIdentity.id,
    email,
    displayName,
    role: profile.role,
  };
}

export function hasAllowedRole(role: AppRole, allowedRoles: readonly AppRole[]): boolean {
  return allowedRoles.includes(role);
}

export function ownsImportSession(userId: string, createdByUser: unknown): boolean {
  return typeof createdByUser === "string" && createdByUser === userId;
}

export function ownsApi(userId: string | null | undefined, record: { created_by_user?: string | null }): boolean {
  return Boolean(userId && record.created_by_user === userId);
}

/** Review status never changes ownership. Historical rows with no owner stay admin-managed. */
export function canManageApi(
  user: Pick<AuthenticatedAppUser, "id" | "role"> | null,
  record: { created_by_user?: string | null },
): boolean {
  return Boolean(user && (user.role === "admin" || ownsApi(user.id, record)));
}
