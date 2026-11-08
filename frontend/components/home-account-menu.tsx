"use client";

import { useEffect, useId, useRef, useState } from "react";
import AuthMenu from "@/components/auth-menu";
import ProductIcon from "@/components/product-icon";
import type { AuthenticatedAppUser } from "@/lib/auth-policy";

export default function HomeAccountMenu({ user }: { user: AuthenticatedAppUser }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const menu = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  return <div className="landing-account-menu" ref={menu} onKeyDown={(event) => {
    if (event.key !== "Escape" || !open) return;
    // The inbox handles Escape itself; keep its parent account panel open.
    if (event.target instanceof Element && event.target.closest(".inbox-panel")) return;
    setOpen(false);
    toggle.current?.focus();
  }}>
    <button type="button" className="landing-account-toggle" ref={toggle} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}>
      <ProductIcon name="user" /><span>My account</span><ProductIcon name="chevron" className="landing-account-chevron" />
    </button>
    <div className="landing-account-panel" id={panelId} hidden={!open}><AuthMenu user={user} /></div>
  </div>;
}
