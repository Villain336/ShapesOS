// ShapesOS — Social: shared client types, classes and small pieces (Phase 4b).
"use client";

import type { ReactNode } from "react";
import { Film } from "lucide-react";

export type PostStatus = "draft" | "pending_approval" | "approved" | "scheduled" | "published" | "failed" | "cancelled";

export interface Media {
  fileId: string;
  filename: string;
  mimeType: string;
  kind: "image" | "video";
  sizeBytes: number;
  width?: number | null;
  height?: number | null;
}

export interface Channel {
  id: string;
  identifier: string;
  platform?: string;
  name: string;
  picture?: string | null;
}

export interface Metrics {
  impressions: number;
  likes: number;
  comments: number;
  shares: number;
  clicks: number;
  engagements: number;
  mock: boolean;
}

export interface Post {
  id: string;
  content: string;
  link: string | null;
  utmCampaign: string | null;
  channels: Channel[];
  platforms: string[];
  media: Media[];
  publishMode: "now" | "schedule";
  scheduledFor: string | null;
  status: PostStatus;
  source: string;
  sourceRef: string | null;
  provider: string | null;
  providerRefs: Array<{ postId: string; integrationId: string; platform: string; state?: string | null; releaseUrl?: string | null }>;
  createdBy: string;
  requestedBy: string | null;
  decisionNote: string | null;
  publishedAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  metrics: Metrics | null;
}

export type ProviderMode = "postiz" | "mock" | "none";

export async function api<T>(url: string, opts?: RequestInit): Promise<T> {
  const isForm = typeof FormData !== "undefined" && opts?.body instanceof FormData;
  const res = await fetch(url, {
    ...opts,
    headers: { ...(isForm ? {} : { "content-type": "application/json" }), ...(opts?.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

export const inputCls =
  "h-control-sm w-full rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)]";
export const textareaCls =
  "w-full rounded-md border-[1.5px] border-control bg-paper px-3 py-2 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)]";
export const btnPrimary =
  "inline-flex h-control-sm cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full bg-ink px-4 text-sm font-semibold text-paper aos-press hover:bg-night-hover focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:cursor-not-allowed disabled:opacity-40";
export const btnSecondary =
  "inline-flex h-control-sm cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full bg-paper px-3 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:cursor-not-allowed disabled:opacity-40";
export const btnApprove =
  "inline-flex h-control-sm cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full bg-done px-4 text-sm font-semibold text-white aos-press focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:cursor-not-allowed disabled:opacity-40";
export const btnDeny =
  "inline-flex h-control-sm cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full bg-paper px-3 text-sm font-semibold text-failed-text shadow-[inset_0_0_0_1.5px_var(--aos-failed)] aos-press hover:bg-failed-tint focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:cursor-not-allowed disabled:opacity-40";
export const btnQuiet =
  "inline-flex h-8 cursor-pointer items-center gap-1 whitespace-nowrap rounded-full px-2.5 text-[13px] font-semibold text-ink hover:bg-hover focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:cursor-not-allowed disabled:opacity-40";
export const cardCls = "rounded-lg bg-paper shadow-hairline";
export const thCls = "px-3 py-2 text-left text-xs font-semibold text-muted";
export const thNum = "px-3 py-2 text-right text-xs font-semibold text-muted";
export const tdCls = "px-3 py-2.5 align-top text-[13px] text-ink";
export const tdNum = "px-3 py-2.5 align-top text-right text-[13px] tabular-nums text-ink";

const chipBase = "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-canvas px-2 py-0.5 text-[12px] font-semibold text-ink";

/** Post state: needs-you triangle for approvals, done/failed shapes, queued outline when handed off. */
export function StatusChip({ status, scheduledFor }: { status: PostStatus; scheduledFor?: string | null }) {
  const due = isPast(scheduledFor ?? null);
  switch (status) {
    case "pending_approval":
      return (
        <span className={chipBase}>
          <span className="aos-shape aos-shape--needs aos-shape--edged" role="img" aria-label="Needs approval" />
          Needs approval
        </span>
      );
    case "approved":
    case "scheduled":
      return due ? (
        <span className={chipBase}>
          <span className="aos-shape aos-shape--running aos-is-live" role="img" aria-label="Publishing" />
          Publishing
        </span>
      ) : (
        <span className={chipBase}>
          <span className="aos-shape aos-shape--queued" role="img" aria-label="Scheduled" />
          Scheduled
        </span>
      );
    case "published":
      return (
        <span className={chipBase}>
          <span className="aos-shape aos-shape--done" role="img" aria-label="Published" />
          Published
        </span>
      );
    case "failed":
      return (
        <span className={chipBase}>
          <span className="aos-shape aos-shape--failed" role="img" aria-label="Failed" />
          Failed
        </span>
      );
    case "cancelled":
      return <span className={`${chipBase} text-muted`}>Cancelled</span>;
    default:
      return <span className={`${chipBase} text-muted`}>Draft</span>;
  }
}

export function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-6 items-center rounded-full bg-canvas px-2 text-[12px] font-semibold text-ink">{children}</span>
  );
}

export function mediaUrl(fileId: string): string {
  return `/api/social/media/${encodeURIComponent(fileId)}`;
}

/** Square thumbnail for an image or a video (first frame via preload=metadata). */
export function Thumb({ media, size = 40 }: { media: Media; size?: number }) {
  const style = { width: size, height: size };
  if (media.kind === "video") {
    return (
      <span className="relative inline-block shrink-0 overflow-hidden rounded-sm bg-canvas" style={style}>
        <video src={mediaUrl(media.fileId)} preload="metadata" muted className="h-full w-full object-cover" aria-label={media.filename} />
        <Film className="absolute bottom-0.5 right-0.5 h-3.5 w-3.5 text-paper" aria-hidden />
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={mediaUrl(media.fileId)} alt={media.filename} className="shrink-0 rounded-sm bg-canvas object-cover" style={style} />
  );
}

/** True when the ISO time has passed (a clock read, kept out of component bodies). */
export function isPast(iso: string | null): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && t <= Date.now();
}

export function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function fmtInt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US");
}

export function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** When a post sits on the calendar: published, else scheduled, else created. */
export function postWhen(p: Pick<Post, "publishedAt" | "scheduledFor" | "createdAt">): string {
  return p.publishedAt ?? p.scheduledFor ?? p.createdAt;
}
