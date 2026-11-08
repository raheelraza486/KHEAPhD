"use client";

import { useState } from "react";
import type { AuthenticatedAppUser } from "@/lib/auth-policy";
import { createClient } from "@/lib/supabase/client";
import NotificationInbox from "@/components/notification-inbox";
import ProductIcon from "@/components/product-icon";

type AuthMenuProps = {
  user: AuthenticatedAppUser | null;
  sidebar?: boolean;
  profileActive?: boolean;
};

const roleLabels = {
  viewer: "Viewer",
  publisher: "User",
  admin: "Administrator",
} as const;

export default function AuthMenu({ user, sidebar = false, profileActive }: AuthMenuProps) {
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState("");

  if (!user) {
    return <a className="button primary header-login" href="/login"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="7" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></svg><span>Log in</span></a>;
  }

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    setError("");
    try {
      const supabase = createClient();
      const result = await supabase.auth.signOut();
      if (result.error) throw result.error;
      window.location.assign("/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not log out. Please try again.");
      setSigningOut(false);
    }
  }

  const name = user.displayName || user.email;
  const role = roleLabels[user.role];
  const logoutLabel = signingOut ? "Logging out…" : "Log out";
  const errorMessage = error && <span className="header-auth-error" role="alert">{error}</span>;

  if (sidebar) return (
    <div className="sidebar-account-menu">
      <nav className="sidebar-account-navigation" aria-label="Account navigation">
        <NotificationInbox role={user.role} showIcon />
        <a className="sidebar-account-row" href="/profile" aria-current={profileActive ? "page" : undefined}>
          <ProductIcon name="user" />
          <span>My Profile</span>
          <ProductIcon name="chevron" className="sidebar-account-chevron" />
        </a>
      </nav>
      <div className="sidebar-account-details">
        <div className="sidebar-account-identity">
          <span className="sidebar-account-avatar"><ProductIcon name="user" /></span>
          <div className="sidebar-account-name">
            <strong title={name}>{name}</strong>
            <small>{role}</small>
          </div>
        </div>
        <button className="sidebar-account-row" type="button" onClick={signOut} disabled={signingOut}>
          <ProductIcon name="logout" /><span>{logoutLabel}</span>
        </button>
        {errorMessage}
      </div>
    </div>
  );

  return (
    <div className="header-account">
      <NotificationInbox role={user.role} />
      <a className="header-identity profile-link" href="/profile" title={user.email} aria-current={profileActive ? "page" : undefined}>
        <strong>{name}</strong>
        <small>Profile · {role}</small>
      </a>
      <button className="button secondary header-logout" type="button" onClick={signOut} disabled={signingOut}>
        {logoutLabel}
      </button>
      {errorMessage}
    </div>
  );
}
