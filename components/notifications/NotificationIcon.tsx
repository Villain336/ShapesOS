"use client";

// ShapesOS — Phase 3 (J): notification kind marks + shared client types.
// Needs-you and failed-run notifications ARE agent states, so they carry the
// status shape (yellow triangle with its black edge on white; red square).
// The other kinds are informational and use neutral Lucide icons.

import { CheckCheck, Siren, UserPlus } from "lucide-react";

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

export function NotificationIcon({ kind }: { kind: NotificationKind }) {
  const wrap = "mt-0.5 flex size-6 shrink-0 items-center justify-center";
  switch (kind) {
    case "approval_needed":
      return (
        <span className={wrap}>
          <span className="aos-shape aos-shape--needs aos-shape--edged [--aos-shape-size:14px]" role="img" aria-label="Needs you" />
        </span>
      );
    case "run_failed":
      return (
        <span className={wrap}>
          <span className="aos-shape aos-shape--failed [--aos-shape-size:12px]" role="img" aria-label="Failed" />
        </span>
      );
    case "alert_fired":
      return (
        <span className={`${wrap} text-ink`}>
          <Siren size={16} aria-hidden />
        </span>
      );
    case "invite_accepted":
      return (
        <span className={`${wrap} text-ink`}>
          <UserPlus size={16} aria-hidden />
        </span>
      );
    default:
      return (
        <span className={`${wrap} text-ink`}>
          <CheckCheck size={16} aria-hidden />
        </span>
      );
  }
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
