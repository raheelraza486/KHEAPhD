"use client";

import { useEffect, useState } from "react";
import ProductIcon from "@/components/product-icon";
import { catalogueElementTop, catalogueScrollContainer, catalogueScrollTop, scrollCatalogueTo } from "@/lib/catalog-scroll";

type Props = { targetId: string; focusId: string; label?: string };

export default function BackToTop({ targetId, focusId, label = "Back to top" }: Props) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const target = document.getElementById(targetId);
    if (!target) return;
    let container: HTMLElement | Window | undefined;
    const update = () => {
      if (container) setVisible(catalogueScrollTop(container) - catalogueElementTop(target, container) > 300);
    };
    const bind = () => {
      const next = catalogueScrollContainer(target);
      if (container !== next) {
        container?.removeEventListener("scroll", update);
        container = next;
        container.addEventListener("scroll", update, { passive: true });
      }
      update();
    };
    bind();
    const resize = new ResizeObserver(bind);
    resize.observe(target);
    window.addEventListener("resize", bind);
    return () => {
      container?.removeEventListener("scroll", update);
      window.removeEventListener("resize", bind);
      resize.disconnect();
    };
  }, [targetId]);

  if (!visible) return null;
  return <button className="api-detail-control page-back-to-top" type="button" aria-label={label} title="Back to top" onClick={() => {
    const target = document.getElementById(targetId);
    if (!target) return;
    document.getElementById(focusId)?.focus({ preventScroll: true });
    scrollCatalogueTo(target, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth");
  }}><ProductIcon name="back-to-top" /><span className="api-control-tooltip">Back to top</span></button>;
}
