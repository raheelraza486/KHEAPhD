"use client";

import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import ProductIcon from "@/components/product-icon";
import type { AppRole } from "@/lib/auth-policy";
import { notificationDestination, notificationTitle, type ApiNotification } from "@/lib/notifications";

type InboxPage = { notifications: ApiNotification[]; unread_count: number; next_offset: number | null; submission_notifications_available?: boolean; error?: string };

export default function NotificationInbox({ role, showIcon = false }: { role: AppRole; showIcon?: boolean }) {
  const isAdmin = role === "admin";
  const [items, setItems] = useState<ApiNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState("");
  const [markingAll, setMarkingAll] = useState(false);
  const [submissionAlertsAvailable, setSubmissionAlertsAvailable] = useState(true);
  const busy = useRef(false);
  const details = useRef<HTMLDetailsElement>(null);

  const load = useCallback(async (offset = 0) => {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    try {
      const response = await fetch(`/api/notifications?offset=${offset}`, { cache: "no-store" });
      const payload = await response.json() as InboxPage;
      if (!response.ok) throw new Error(payload.error || "Could not load your inbox.");
      setItems((current) => offset === 0 ? payload.notifications
        : [...current, ...payload.notifications.filter((item) => !current.some((existing) => existing.id === item.id))]);
      setUnread(payload.unread_count);
      setNextOffset(payload.next_offset);
      setSubmissionAlertsAvailable(payload.submission_notifications_available !== false);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load your inbox.");
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const refresh = () => {
      if (document.visibilityState === "visible" && !details.current?.open) void load();
    };
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load]);

  async function openNotification(event: MouseEvent<HTMLAnchorElement>, item: ApiNotification) {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (opening) return;
    setOpening(item.id);
    try {
      if (!item.read_at) {
        const response = await fetch("/api/notifications", {
          method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: item.id }),
        });
        if (!response.ok) throw new Error("Could not mark this notification as read. Please try again.");
        setItems((current) => current.map((row) => row.id === item.id ? { ...row, read_at: new Date().toISOString() } : row));
        setUnread((count) => Math.max(0, count - 1));
      }
      window.location.assign(notificationDestination(item, role));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open this notification.");
      setOpening("");
    }
  }

  async function markAllAsRead() {
    if (unread === 0 || markingAll) return;
    setMarkingAll(true);
    try {
      const response = await fetch("/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mark_all_read" }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not mark all notifications as read.");
      const readAt = new Date().toISOString();
      setItems((current) => current.map((item) => item.read_at ? item : { ...item, read_at: readAt }));
      setUnread(0);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not mark all notifications as read.");
    } finally {
      setMarkingAll(false);
    }
  }

  return (
    <details className="notification-inbox" ref={details} onToggle={() => { if (details.current?.open) void load(); }} onKeyDown={(event) => {
      if (event.key === "Escape" && details.current) { details.current.open = false; details.current.querySelector("summary")?.focus(); }
    }}>
      <summary aria-label={`Inbox${unread ? `, ${unread} unread` : ""}`}>
        {showIcon && <ProductIcon name="inbox" />}Inbox
        {unread > 0 && <span className="inbox-count" aria-hidden="true">{unread > 99 ? "99+" : unread}</span>}
      </summary>
      <section className="inbox-panel" aria-label={isAdmin ? "Submission notifications" : "Verification notifications"}>
        <div className="inbox-heading"><h2>Inbox</h2><div className="inbox-heading-actions">{unread > 0 && <button className="text-button" type="button" disabled={loading || markingAll} onClick={() => void markAllAsRead()}>{markingAll ? "Marking…" : "Mark all as read"}</button>}<button className="text-button" type="button" disabled={loading || markingAll} onClick={() => void load()}>Refresh</button></div></div>
        <p>{isAdmin ? "New API submissions from users." : "Updates about APIs you submitted."} Settled field decisions appear here too.</p>
        {isAdmin && !submissionAlertsAvailable && <p className="submission-help">New submission alerts are not enabled yet. Use “View awaiting verification” below to review APIs.</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        {loading && items.length === 0 && <p role="status">Loading notifications…</p>}
        {!loading && !error && items.length === 0 && <p>{isAdmin ? submissionAlertsAvailable ? "No notifications yet. We’ll notify you here when a user submits an API." : "No notifications yet." : "No notifications yet. We’ll notify you here when an API you submitted is verified."}</p>}
        <ul className="inbox-items">{items.map((item) => <li key={item.id} className={item.read_at ? "" : "unread"}>
          <a href={notificationDestination(item, role)} onClick={(event) => void openNotification(event, item)} aria-busy={opening === item.id}>
            <strong>{notificationTitle(item)}{!item.read_at && <span className="sr-only"> (unread)</span>}</strong>
            <time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString()}</time>
            <span>{item.kind === "conflict_settled" ? "View the pair →" : item.kind === "changes_requested" ? "View feedback →" : item.kind === "new_submission" || item.kind === "api_updated" ? "Review submission →" : "View API →"}</span>
          </a>
        </li>)}</ul>
        {nextOffset !== null && <button className="text-button" type="button" disabled={loading} onClick={() => void load(nextOffset)}>{loading ? "Loading…" : "Load older notifications"}</button>}
        <a className="inbox-all" href={isAdmin ? "/apis?status=Published" : "/profile?view=submissions"}>{isAdmin ? "View awaiting verification" : "View all my submissions"}</a>
      </section>
    </details>
  );
}
