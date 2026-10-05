"use client";

// ShapesOS — Phase 3 (J): notification kind marks + shared client types.
// Needs-you, failed-run and approved notifications ARE agent states, so they
// carry the status shape (yellow triangle with its black edge on white; red
// square; green quarter-disc) — lib/aos/notifications decides. The other
// kinds are informational and use neutral Lucide icons.

import { CheckCheck, Siren, UserPlus, type LucideIcon } from "lucide-react";
import { StatusShape } from "@/components/aos/StatusShape";
import { notificationStatus } from "@/lib/aos/notifications";
import { STATUS_META } from "@/lib/aos/status";

export type NotificationKind =
  | "approval_needed"
  | "approval_decided"
  | "alert_fired"
  | "run_failed"
  | "invite_accepted";

export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  href: string | null;
  readAt: string | null;
  createdAt: string;
}

export const NOTIFICATION_KIND_LABELS: Record<NotificationKind, string> = {
  approval_needed: "Needs you",
  approval_decided: "Decisions",
  alert_fired: "Alerts",
  run_failed: "Failed runs",
  invite_accepted: "Team",
};

/** Neutral lead icon for notifications that are not an agent state. */
export const NOTIFICATION_KIND_ICONS: Record<NotificationKind, LucideIcon> = {
  approval_needed: CheckCheck,
  approval_decided: CheckCheck,
  alert_fired: Siren,
  run_failed: Siren,
  invite_accepted: UserPlus,
};

export function NotificationIcon({ kind, title = "" }: { kind: NotificationKind; title?: string }) {
  const wrap = "mt-0.5 flex size-6 shrink-0 items-center justify-center";
  const status = notificationStatus({ kind, title });
  if (status) {
    return (
      <span className={wrap}>
        <StatusShape status={status} size={status === "needs" ? 14 : 12} label={STATUS_META[status].label} />
      </span>
    );
  }
  const Icon = NOTIFICATION_KIND_ICONS[kind] ?? CheckCheck;
  return (
    <span className={`${wrap} text-ink`}>
      <Icon size={16} aria-hidden />
    </span>
  );
}

export function timeAgo(iso: string, now: number = Date.now()): string {
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (!Number.isFinite(s)) return "";
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}
