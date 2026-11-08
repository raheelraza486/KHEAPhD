import AdminReviewAlert from "@/components/admin-review-alert";
import AuthMenu from "@/components/auth-menu";
import SidebarNavigation from "@/components/sidebar-navigation";
import HomeAccountMenu from "@/components/home-account-menu";
import type { AuthenticatedAppUser } from "@/lib/auth-policy";
import type { ApiView, SitePage } from "@/lib/site-navigation";

type SiteHeaderProps = { active: SitePage; user: AuthenticatedAppUser | null; apiView?: ApiView };

export default function SiteHeader({ active, user, apiView = "all" }: SiteHeaderProps) {
  if (active === "home") {
    return <header className="landing-account-bar">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      {user ? <HomeAccountMenu user={user} /> : <a className="landing-login" href="/login">Log in <span aria-hidden="true">↗</span></a>}
      {user?.role === "admin" && <AdminReviewAlert />}
    </header>;
  }

  return <header className="app-sidebar" data-role={user?.role ?? "guest"}>
    <a className="skip-link" href="#main-content">Skip to main content</a>
    <div className="sidebar-brand-row">
      <a className="sidebar-brand" href="/" aria-label="Business API Repository home">
        <span className="sidebar-brand-mark" aria-hidden="true"><i /><i /></span>
        <span>Business API<br />Repository</span>
      </a>
      <span className="sidebar-role">{user?.role === "admin" ? "Administrator" : user?.role === "publisher" ? "User" : user?.role === "viewer" ? "Viewer" : "Explore"}</span>
    </div>
    <SidebarNavigation active={active} role={user?.role ?? null} apiView={apiView} />
    <div className="sidebar-account"><AuthMenu user={user} sidebar profileActive={active === "profile"} /></div>
    {user?.role === "admin" && <AdminReviewAlert />}
  </header>;
}
