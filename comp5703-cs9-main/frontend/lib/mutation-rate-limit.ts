import type { AuthenticatedAppUser } from "./auth-policy";

export type MutationAction = "upload" | "edit" | "verification" | "import";
type RateLimitUser = Pick<AuthenticatedAppUser, "id" | "role">;

function createWindowLimiter(windowMs: number, maxRequests: number) {
  const requestsByKey = new Map<string, number[]>();
  let nextCleanupAt = 0;

  // Zero allows the request; a positive result is the Retry-After delay in seconds.
  return (key: string, now: number): number => {
    if (now >= nextCleanupAt) {
      for (const [id, timestamps] of requestsByKey) {
        if (now - timestamps[timestamps.length - 1] >= windowMs) {
          requestsByKey.delete(id);
        }
      }
      nextCleanupAt = now + windowMs;
    }

    const recent = (requestsByKey.get(key) ?? []).filter(
      (timestamp) => now - timestamp < windowMs,
    );
    if (recent.length >= maxRequests) {
      // Rejected retries do not consume quota or extend the waiting period.
      requestsByKey.set(key, recent);
      return Math.ceil((recent[0] + windowMs - now) / 1_000);
    }

    recent.push(now);
    requestsByKey.set(key, recent);
    return 0;
  };
}

/** Process-local quotas. Call only after origin and role checks, with the trusted session user. */
export function createMutationRateLimiter() {
  // Each administrative action has its own quota so editing cannot exhaust verification.
  const adminLimit = createWindowLimiter(60_000, 120);
  const submissionLimit = createWindowLimiter(60 * 60_000, 10);
  // Starting an import is deliberately stricter and follows the authenticated
  // account, so people behind one shared IP address do not exhaust each other's quota.
  const importLimit = createWindowLimiter(60_000, 5);

  return (action: MutationAction, user: RateLimitUser, clientKey: string, now = Date.now()): number => {
    if (action === "import") return importLimit(user.id, now);
    if (user.role === "admin") return adminLimit(`${action}:${user.id}`, now);
    return submissionLimit(`${action}:${clientKey}`, now);
  };
}

export const checkMutationRateLimit = createMutationRateLimiter();
