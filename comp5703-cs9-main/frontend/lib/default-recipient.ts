import { ADMIN_ROLES, type AppRole } from "./auth-policy.ts";

/**
 * The address a send form starts with. An administrator account can be a
 * shared one without a real inbox, so an administrator starts with the first
 * address the server allows (MAILGUN_ALLOWED_RECIPIENTS); everyone else starts
 * with their own address. The person can still change it, and the send routes
 * check the address either way.
 */
export function defaultRecipient(
  user: { email: string; role: AppRole } | null | undefined,
  allowed: string | undefined = process.env.MAILGUN_ALLOWED_RECIPIENTS,
): string {
  if (!user) return "";
  const first = (allowed ?? "").split(",").map((entry) => entry.trim()).find(Boolean);
  return first && (ADMIN_ROLES as readonly AppRole[]).includes(user.role) ? first : user.email;
}
