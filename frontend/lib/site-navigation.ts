import type { AppRole } from "./auth-policy";

export type SitePage = "home" | "apis" | "discovery" | "workflow" | "canvas" | "compatibility" | "decisions" | "reviews" | "compose" | "about" | "login" | "submit" | "profile";
export type ApiView = "all" | "awaiting" | "mine";
export type NavigationIcon = "document" | "search" | "workflow" | "check" | "grid" | "compare" | "review" | "upload";
export type NavigationItem = { label: string; href: string; icon: NavigationIcon; active: boolean };
export type NavigationGroup = { id: string; label: string; icon: NavigationIcon; items: NavigationItem[] };

/** Presentation only: destinations and access rules match the existing navigation. */
export function siteNavigation(role: AppRole | null, active: SitePage, apiView: ApiView): NavigationGroup[] {
  const groups: NavigationGroup[] = [
    { id: "publish", label: role === "viewer" ? "My APIs" : "Share your API", icon: "document", items: [
      ...(role === "publisher" || role === "admin" ? [{ label: "Add API", href: "/submit", icon: "upload" as const, active: active === "submit" }] : []),
      ...(role ? [{ label: "My field decisions", href: "/compatibility/decisions", icon: "document" as const, active: active === "decisions" }] : []),
    ] },
    { id: "discover", label: "Find APIs", icon: "search", items: [
      { label: "All APIs", href: "/apis", icon: "grid", active: active === "apis" && apiView === "all" },
      { label: "API Discovery", href: "/discovery", icon: "search", active: active === "discovery" },
    ] },
    { id: "build", label: "Build a workflow", icon: "workflow", items: [
      ...(role ? [{ label: "Create a workflow", href: "/workflows/create", icon: "workflow" as const, active: active === "workflow" }] : []),
      { label: "Workflow canvas", href: "/workflows/canvas", icon: "workflow", active: active === "canvas" },
      { label: "Compatibility", href: "/compatibility", icon: "compare", active: active === "compatibility" },
      ...(role ? [{ label: "Invoice workflows", href: "/compose/pdf-invoice", icon: "workflow" as const, active: active === "compose" }] : []),
    ] },
    { id: "manage", label: "Administration", icon: "check", items: role === "admin" ? [
      { label: "Awaiting verification", href: "/apis?status=Published", icon: "check", active: active === "apis" && apiView === "awaiting" },
      { label: "Pending review", href: "/compatibility/reviews", icon: "review", active: active === "reviews" },
    ] : [] },
  ];
  return groups.filter((group) => group.items.length > 0);
}
