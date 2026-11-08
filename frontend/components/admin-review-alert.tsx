"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * The corner notice telling an administrator how many API pairs are waiting to
 * be settled.
 *
 * It counts pairs, not fields: one pair can hold several disputed fields, and
 * what an administrator opens is a pair. The count comes from the same route
 * as the work list, so the two can never disagree.
 *
 * It appears only when there is something to do, and closing it keeps it away
 * for the rest of the session unless the number changes — an administrator
 * moving between pages should not have to dismiss the same notice repeatedly.
 *
 * It is rendered into document.body through a portal rather than where it is
 * mounted. `position: fixed` is resolved against the nearest ancestor with a
 * transform, filter or backdrop-filter rather than against the viewport, and
 * the site header has `backdrop-filter: blur(16px)`: mounted inside it, the
 * notice was positioned against a strip a few pixels tall and was clipped by
 * it. The portal takes it out of that ancestor for good.
 */
const POLL_MS = 60_000;
const DISMISSED_KEY = "cs9.review-alert.dismissed-at";

type ConflictSummary = { pairs?: number; complete?: boolean };

export default function AdminReviewAlert() {
  const pathname = usePathname();
  const [pairs, setPairs] = useState(0);
  const [complete, setComplete] = useState(true);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);

  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(DISMISSED_KEY);
      if (stored !== null) setDismissedAt(Number(stored));
    } catch {
      // Private windows and blocked storage simply never remember a dismissal.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      try {
        const response = await fetch("/api/checks/conflicts", { cache: "no-store" });
        // 401 / 403: not an administrator (or no longer one). Show nothing at
        // all rather than an empty notice.
        if (!response.ok) {
          if (!cancelled && (response.status === 401 || response.status === 403)) setPairs(0);
          return;
        }
        const payload = (await response.json()) as ConflictSummary;
        if (cancelled) return;
        setPairs(payload.pairs ?? 0);
        setComplete(payload.complete !== false);
      } catch {
        // A failed poll leaves the last count alone; the next one corrects it.
      }
    };
    void read();
    const timer = setInterval(() => void read(), POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  // On the work list itself the notice says nothing new and covers the page.
  if (pathname?.startsWith("/compatibility/reviews")) return null;
  if (pairs === 0) return null;
  // Dismissing hides this count; a different count is new information.
  if (dismissedAt === pairs) return null;
  if (typeof document === "undefined") return null;

  const dismiss = () => {
    setDismissedAt(pairs);
    try {
      sessionStorage.setItem(DISMISSED_KEY, String(pairs));
    } catch {
      // Nothing to do: the notice stays hidden for this page either way.
    }
  };

  return createPortal(
    <aside className="review-alert" role="status" aria-live="polite">
      <div>
        <strong>{pairs} {pairs === 1 ? "API pair is" : "API pairs are"} waiting for your decision</strong>
        <p>
          Users gave different answers for the same field, so nothing is applied until you settle it.
          {!complete && " More pairs have saved answers than could be checked at once, so there may be others."}
        </p>
      </div>
      <div className="review-alert-actions">
        <a className="button primary" href="/compatibility/reviews">Review</a>
        <button type="button" className="compat-text-button" onClick={dismiss}>Dismiss</button>
      </div>
    </aside>,
    document.body,
  );
}
