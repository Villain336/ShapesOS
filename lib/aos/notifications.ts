// ShapesOS — notifications in the kit's toast pattern (pure).
//
// A notification draws like a kit toast (toasts-and-banners.png): led by
// the status shape when it reports an agent state — approval needed (needs
// you), run failed (failed), a request approved (done) — otherwise by a
// neutral icon, never a status color (alerts, invites, denials are not agent
// states). Exactly one action, named for what it opens. Unread needs-you
// and failed notifications roll up into banners over the list.

import type { AosColorStatus } from "./status";

export interface NotificationLike {
  kind: string;
  title: string;
  body?: string | null;
  href?: string | null;
  readAt?: string | null;
}

export function notificationStatus(n: Pick<NotificationLike, "kind" | "title">): AosColorStatus | null {
  switch (n.kind) {
    case "approval_needed":
      return "needs";
    case "run_failed":
      return "failed";
    case "approval_decided":
      // "Ad spend approved" → done; "… denied" is a decision, not a failure.
      return /\bapproved\b/i.test(n.title) ? "done" : null;
    default:
      return null;
  }
}

const ACTION_LABELS: Record<string, string> = {
  approval_needed: "Review",
  run_failed: "Open run",
  approval_decided: "Open",
  alert_fired: "Open",
  invite_accepted: "Open team",
};

/** The one action: where the notification points, named for it. Null when it links nowhere. */
export function notificationAction(n: Pick<NotificationLike, "kind" | "href">): { label: string; href: string } | null {
  if (!n.href) return null;
  const label = n.href.startsWith("/dashboard/runs") ? "Open run" : n.href.startsWith("/dashboard/approvals") ? "Review" : (ACTION_LABELS[n.kind] ?? "Open");
  return { label, href: n.href };
}

export interface NotificationBanner {
  key: string;
  status: "needs" | "failed";
  title: string;
  description: string;
  action: { label: string; href: string };
}

/**
 * Banners over the list (needs first): what waits on this member — the live
 * inbox count when known (`approvals`), else the unread approval
 * notifications — then unread failed runs.
 */
export function notificationBanners(items: readonly NotificationLike[], opts: { approvals?: number | null } = {}): NotificationBanner[] {
  const unread = items.filter((n) => !n.readAt);
  const needs = typeof opts.approvals === "number" ? opts.approvals : unread.filter((n) => n.kind === "approval_needed").length;
  const failed = unread.filter((n) => n.kind === "run_failed");
  const out: NotificationBanner[] = [];
  if (needs > 0) {
    out.push({
      key: "needs",
      status: "needs",
      title: `${needs} ${needs === 1 ? "approval is" : "approvals are"} waiting on you`,
      description: "Agents paused for your approval. Nothing goes out until you decide.",
      action: { label: "Review all", href: "/dashboard/approvals" },
    });
  }
  if (failed.length > 0) {
    out.push({
      key: "failed",
      status: "failed",
      title: failed.length === 1 ? failed[0]!.title : `${failed.length} runs stopped on errors`,
      description:
        failed.length === 1 && failed[0]!.body ? failed[0]!.body : "Open each run to see what failed and how to fix it.",
      action: { label: failed.length === 1 ? "Open run" : "Open runs", href: failed.length === 1 && failed[0]!.href ? failed[0]!.href : "/dashboard/runs" },
    });
  }
  return out;
}
