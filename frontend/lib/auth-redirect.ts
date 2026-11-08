const INTERNAL_ORIGIN = "https://repository.invalid";

/** Keep post-login redirects on this application, even when `next` is user supplied. */
export function safeInternalPath(value: string | null | undefined, fallback = "/apis") {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return fallback;

  try {
    const parsed = new URL(value, INTERNAL_ORIGIN);
    if (parsed.origin !== INTERNAL_ORIGIN) return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}
