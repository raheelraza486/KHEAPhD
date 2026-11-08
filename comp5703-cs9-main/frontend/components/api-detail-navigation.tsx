"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { catalogueElementTop, catalogueScrollContainer, catalogueScrollTop, scrollCatalogueTo } from "@/lib/catalog-scroll";

type Neighbour = { id: string; api_name: string };
type Props = {
  api: Neighbour;
  previous?: Neighbour;
  next?: Neighbour;
  onNavigate: (id: string) => void;
  onBack: () => void;
  disabled: boolean;
};

export default function ApiDetailNavigation({ api, previous, next, onNavigate, onBack, disabled }: Props) {
  const headerRef = useRef<HTMLDivElement>(null);
  const [showTop, setShowTop] = useState(false);

  useLayoutEffect(() => {
    const panel = headerRef.current?.closest<HTMLElement>("#api-detail");
    if (!panel) return;
    const container = catalogueScrollContainer(panel);
    const update = () => setShowTop(catalogueScrollTop(container) - catalogueElementTop(panel, container) > 300);
    scrollCatalogueTo(panel);
    document.getElementById("api-detail-heading")?.focus({ preventScroll: true });
    update();
    container.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      container.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [api.id]);

  function backToTop() {
    const panel = headerRef.current?.closest<HTMLElement>("#api-detail");
    if (!panel) return;
    // Move focus before the triggering button disappears from the accessibility tree.
    document.getElementById("api-detail-heading")?.focus({ preventScroll: true });
    scrollCatalogueTo(panel, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth");
  }

  return <>
    <div className="api-detail-sticky-header" ref={headerRef}>
      <button className="detail-back" type="button" onClick={onBack}>← <span>Back to results</span></button>
      <strong title={api.api_name}>{api.api_name}</strong>
    </div>
    <nav className="api-detail-navigation" aria-label="Browse APIs in current results" inert={disabled}>
      {previous && <button className="api-detail-control api-previous" type="button" onClick={() => onNavigate(previous.id)} aria-label={`Previous API: ${previous.api_name}`} title={`Previous API: ${previous.api_name}`}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 5-7 7 7 7" /></svg><span className="api-control-tooltip">Previous: {previous.api_name}</span>
      </button>}
      {next && <button className="api-detail-control api-next" type="button" onClick={() => onNavigate(next.id)} aria-label={`Next API: ${next.api_name}`} title={`Next API: ${next.api_name}`}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 5 7 7-7 7" /></svg><span className="api-control-tooltip">Next: {next.api_name}</span>
      </button>}
      {showTop && <button className="api-detail-control api-back-to-top" type="button" onClick={backToTop} aria-label="Back to top of API details" title="Back to top">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 14 7-7 7 7M12 7v14M5 3h14" /></svg><span className="api-control-tooltip">Back to top</span>
      </button>}
    </nav>
  </>;
}
