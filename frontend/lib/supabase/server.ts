import "server-only";

import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

type PublicSupabaseConfig = {
  url: string;
  key: string;
};

export class SupabaseAuthConfigurationError extends Error {}

export function getPublicSupabaseConfig(): PublicSupabaseConfig {
  const url = (
    process.env.NEXT_PUBLIC_SUPABASE_URL
    || process.env.SUPABASE_URL
    || ""
  ).trim().replace(/\/$/, "");
  const key = (
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    || process.env.SUPABASE_PUBLISHABLE_KEY
    || process.env.SUPABASE_ANON_KEY
    || ""
  ).trim();

  if (!url || !key) {
    throw new SupabaseAuthConfigurationError(
      "Supabase Auth is not configured. Set the public Supabase URL and publishable key.",
    );
  }
  return { url, key };
}

/**
 * Supabase client for Server Components, Server Actions and route handlers.
 * Cookie names and token chunking remain owned by @supabase/ssr.
 */
export async function createSupabaseServerClient() {
  // Read the request cookie store before configuration validation so pages
  // using this helper always remain request-scoped, including local builds
  // where Auth environment variables have not been filled in yet.
  const cookieStore = await cookies();
  const { url, key } = getPublicSupabaseConfig();

  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(values) {
        try {
          for (const { name, value, options } of values) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // A Server Component cannot write cookies. proxy.ts refreshes them;
          // route handlers and Server Actions can still apply updates here.
        }
      },
    },
  });
}

/** A stateless client for non-browser callers that send an access token. */
export function createSupabaseBearerClient(accessToken: string) {
  const { url, key } = getPublicSupabaseConfig();
  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  });
}
