"use client";

import { useEffect, type ReactNode } from "react";
import { X, Mail, MessageSquare, PhoneCall, Send } from "lucide-react";

// ── Agentic OS atoms ─────────────────────────────────────────────────────────
// Visual migration only: same layout, same behavior. All workflow states
// (sequence, enrollment, message, consent, broadcast states) render as neutral
// chips — these are workflow states, not agent states, so they never take a
// status color. The `tone` prop stays for call-site compatibility.
// Genuine agent/approval states use the dedicated badges below
// (RunningBadge / NeedsBadge / DoneBadge).

export const inputCls =
  "w-full h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none disabled:opacity-50";

export const btnPrimary =
  "inline-flex h-control-sm cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-ink-hover focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:opacity-40";

export const btnSecondary =
  "inline-flex h-control-sm cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:opacity-40";

export const btnDanger =
  "inline-flex h-control-sm cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-paper px-4 text-sm font-semibold text-failed-text aos-press shadow-[inset_0_0_0_1.5px_var(--aos-failed)] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:opacity-40";

export const btnApprove =
  "inline-flex h-control-sm cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-done px-4 text-sm font-semibold text-white aos-press focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:opacity-40";

/** Executes an approved action (irreversible send): running blue. */
export const btnExecute =
  "inline-flex h-control-sm cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-running px-4 text-sm font-semibold text-white aos-press hover:brightness-110 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:opacity-40";

export type Tone = "stone" | "violet" | "green" | "amber" | "red" | "blue" | "zinc";

// Workflow status → chip tone. Every workflow state maps to "stone": these
// are workflow states, not agent states, so they always render neutral.
export const SEQUENCE_STATUS_TONE: Record<string, Tone> = {
  draft: "stone",
  active: "stone",
  paused: "stone",
  archived: "stone",
};

export const ENROLL_STATUS_TONE: Record<string, Tone> = {
  active: "stone",
  paused: "stone",
  completed: "stone",
  unenrolled: "stone",
  bounced: "stone",
};

export const MESSAGE_STATUS_TONE: Record<string, Tone> = {
  queued: "stone",
  sent: "stone",
  delivered: "stone",
  failed: "stone",
  suppressed: "stone",
};

export const CONSENT_STATUS_TONE: Record<string, Tone> = {
  unknown: "stone",
  pending: "stone",
  opted_in: "stone",
  opted_out: "stone",
};

export const APPROVAL_STATUS_TONE: Record<string, Tone> = {
  pending: "stone",
  approved: "stone",
  rejected: "stone",
};

export function Chip({
  children,
  tone = "stone",
  title,
}: {
  children: ReactNode;
  tone?: Tone;
  title?: string;
}) {
  void tone;
  return (
    <span
      title={title}
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-paper px-2 py-0.5 text-xs font-semibold text-muted shadow-control"
    >
      {children}
    </span>
  );
}

/** Genuine agent state: an AI engine or enrichment run in progress. */
export function RunningBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-running px-3 text-xs font-semibold text-white">
      <span
        className="aos-shape aos-shape--running aos-is-live"
        style={{ color: "var(--aos-on-running)" }}
        role="img"
        aria-label="Running"
      />
      {children}
    </span>
  );
}

/** Genuine review state: a human must look at this (pending approval, cost estimate). */
export function NeedsBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-needs px-3 text-xs font-semibold text-ink">
      <span className="aos-shape aos-shape--needs aos-shape--edged" role="img" aria-label="Needs review" />
      {children}
    </span>
  );
}

/** Genuine done state: a human approved this. */
export function DoneBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-done px-3 text-xs font-semibold text-white">
      <span className="aos-shape aos-shape--done" style={{ color: "var(--aos-on-done)" }} role="img" aria-label="Done" />
      {children}
    </span>
  );
}

export function ChannelChip({ channel }: { channel: string }) {
  const Icon =
    channel === "sms"
      ? MessageSquare
      : channel === "voice"
        ? PhoneCall
        : channel === "direct_mail"
          ? Send
          : Mail;
  const label = channel === "direct_mail" ? "Mail" : channel;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-paper px-2 py-0.5 text-xs font-semibold text-muted shadow-control">
      <Icon className="h-3 w-3" aria-hidden />
      {label}
    </span>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-dashed border-line bg-paper px-4 py-10 text-center">
      <p className="text-sm font-semibold text-ink">{title}</p>
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-night/30 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className={`max-h-[90vh] w-full ${wide ? "max-w-4xl" : "max-w-md"} overflow-y-auto rounded-lg border border-line bg-paper shadow-overlay`}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="aos-subheading">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-full p-1.5 text-muted transition-colors hover:bg-hover-paper hover:text-ink"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}
