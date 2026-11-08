"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { AppRole } from "@/lib/auth-policy";
import { siteNavigation, type ApiView, type SitePage } from "@/lib/site-navigation";
import ProductIcon from "@/components/product-icon";

type SidebarNavigationProps = { active: SitePage; role: AppRole | null; apiView: ApiView };

export default function SidebarNavigation(props: SidebarNavigationProps) {
  // Only the dynamic catalogue page needs live query state. Static pages can
  // render their navigation on the server without a search-params boundary.
  return props.active === "apis" ? <CatalogueSidebarNavigation {...props} /> : <Navigation {...props} />;
}

function CatalogueSidebarNavigation({ active, role, apiView }: SidebarNavigationProps) {
  const searchParams = useSearchParams();
  const currentApiView = searchParams
    ? role === "admin" && searchParams.get("status") === "Published" ? "awaiting"
      : role && role !== "admin" && searchParams.get("scope") === "mine" ? "mine" : "all"
    : apiView;
  return <Navigation active={active} role={role} apiView={currentApiView} />;
}

function Navigation({ active, role, apiView }: SidebarNavigationProps) {
  const groups = siteNavigation(role, active, apiView);
  const currentGroup = groups.find((group) => group.items.some((item) => item.active))?.id ?? null;
  const [openGroups, setOpenGroups] = useState<string[]>(() => currentGroup ? [currentGroup] : []);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    setOpenGroups((previous) => currentGroup && !previous.includes(currentGroup) ? [...previous, currentGroup] : previous);
    setMobileOpen(false);
  }, [currentGroup]);
  useEffect(() => {
    if (!mobileOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !(event.target instanceof Element) || !event.target.closest(".app-sidebar")) return;
      setMobileOpen(false);
      document.querySelector<HTMLButtonElement>(".sidebar-mobile-toggle")?.focus();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [mobileOpen]);

  return <>
    <button className="sidebar-mobile-toggle" type="button" aria-expanded={mobileOpen} aria-controls="workspace-navigation" onClick={() => setMobileOpen(!mobileOpen)}>
      <ProductIcon name={mobileOpen ? "close" : "menu"} /><span>{mobileOpen ? "Close menu" : "Menu"}</span>
    </button>
    <nav className={`sidebar-navigation${mobileOpen ? " is-open" : ""}`} id="workspace-navigation" aria-label="Primary navigation">
      <a className="sidebar-home" href="/" aria-current={active === "home" ? "page" : undefined}><ProductIcon name="home" /><span>Home</span></a>
      <p className="sidebar-section-label">Workspace</p>
      {groups.map((group) => <div className="sidebar-group" key={group.id} data-current={group.id === currentGroup || undefined}>
        <button className="sidebar-group-toggle" type="button" aria-expanded={openGroups.includes(group.id)} aria-controls={`navigation-${group.id}`} onClick={() => setOpenGroups((previous) => previous.includes(group.id) ? previous.filter((id) => id !== group.id) : [...previous, group.id])}>
          <ProductIcon name={group.icon} /><span>{group.label}</span><ProductIcon name="chevron" className="sidebar-chevron" />
        </button>
        <div className="sidebar-group-links" id={`navigation-${group.id}`} hidden={!openGroups.includes(group.id)}>
          {group.items.map((item) => <a key={item.href} href={item.href} aria-current={item.active ? "page" : undefined}><ProductIcon name={item.icon} /><span>{item.label}</span></a>)}
        </div>
      </div>)}
      <a className="sidebar-help" href="/about" aria-current={active === "about" ? "page" : undefined}><ProductIcon name="book" /><span>How it works</span></a>
    </nav>
  </>;
}
