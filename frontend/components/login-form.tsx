"use client";

import { FormEvent, useState } from "react";
import { isAppRole } from "@/lib/auth-policy";
import { createClient } from "@/lib/supabase/client";
import { safeInternalPath } from "@/lib/auth-redirect";

type LoginFormProps = {
  nextPath?: string;
};

export default function LoginForm({ nextPath }: LoginFormProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setError("");
    try {
      const supabase = createClient();
      const result = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (result.error) {
        setError("The email or password is incorrect, or this account is not active.");
        return;
      }

      const identity = result.data.user;
      const profileResult = identity
        ? await supabase
            .from("app_user")
            .select("role,is_active")
            .eq("id", identity.id)
            .maybeSingle()
        : { data: null, error: new Error("No authenticated identity was returned.") };
      const profile = profileResult.data as { role?: unknown; is_active?: unknown } | null;
      if (profileResult.error || !profile || profile.is_active !== true || !isAppRole(profile.role)) {
        await supabase.auth.signOut();
        setError(
          profileResult.error
            ? "Your account was authenticated, but its repository permissions could not be checked. Please try again."
            : "Your account was authenticated, but it has no active repository role. Ask an administrator for access.",
        );
        return;
      }
      window.location.assign(safeInternalPath(nextPath));
    } catch (cause) {
      setError(cause instanceof Error
        ? cause.message
        : "Sign-in is temporarily unavailable. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="login-form" onSubmit={signIn}>
      <label>
        <span>Email</span>
        <input
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={submitting}
        />
      </label>
      <label>
        <span>Password</span>
        <input
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={submitting}
        />
      </label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="button primary" type="submit" disabled={submitting}>
        {submitting ? "Signing in…" : "Log in"}
      </button>
      <p className="login-role-note">
        Use your assigned account. User and administrator access is selected automatically from your account role.
      </p>
    </form>
  );
}
