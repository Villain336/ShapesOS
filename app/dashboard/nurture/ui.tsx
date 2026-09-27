// Marketr — nurture UI primitives (light mode, dense, violet accents).
"use client";

import type { ReactNode } from "react";
import { FileText, Mail, Mailbox, MessageCircle, Phone, X } from "lucide-react";

export type Tone = "violet" | "green" | "amber" | "red" | "blue" | "stone" | "zinc";

const TONE_CLASSES: Record<Tone, string> = {
  // "violet" is the legacy tone name — it resolves to the runtime brand vars
  // (Phase 13 Wave A theming), NOT a hardcoded violet.
  violet: "bg-brand-50 text-brand-700 border-violet-200",
  green: "bg-emerald-50 text-emerald-700 border-emerald-200",
  amber: "bg-amber-50 text-amber-700 border-amber-200",
  red: "bg-red-50 text-red-700 border-red-200",
  blue: "bg-sky-50 text-sky-700 border-sky-200",
  stone: "bg-stone-100 text-stone-600 border-stone-200",
  zinc: "bg-zinc-100 text-zinc-500 border-zinc-200",
};

export function Chip({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[11px] font-medium leading-4 ${TONE_CLASSES[tone]}`}
    >
      {children}
    </span>
  );
}

export function ChannelChip({ channel }: { channel: string }) {
  const tone: Tone =
    channel === "sms"
      ? "green"
      : channel === "email"
        ? "blue"
        : channel === "postcard" || channel === "letter"
          ? "amber"
          : "violet";
  const Icon =
    channel === "sms"
      ? MessageCircle
      : channel === "email"
        ? Mail
        : channel === "postcard"
          ? Mailbox
          : channel === "letter"
            ? FileText
            : Phone;
  return (
    <Chip tone={tone}>
      <Icon size={11} />
      {channel}
    </Chip>
  );
}

export const SEQUENCE_STATUS_TONE: Record<string, Tone> = {
  draft: "stone",
  active: "green",
  paused: "amber",
  archived: "zinc",
};

export const ENROLL_STATUS_TONE: Record<string, Tone> = {
  active: "violet",
  paused: "amber",
  completed: "green",
  unenrolled: "stone",
  bounced: "red",
};

export const MESSAGE_STATUS_TONE: Record<string, Tone> = {
  queued: "amber",
  sent: "blue",
  delivered: "green",
  failed: "red",
  suppressed: "stone",
};

export const CONSENT_STATUS_TONE: Record<string, Tone> = {
  opted_in: "green",
  opted_out: "red",
  pending: "amber",
  unknown: "zinc",
};

export const APPROVAL_STATUS_TONE: Record<string, Tone> = {
  pending: "amber",
  approved: "green",
  rejected: "red",
  expired: "zinc",
};

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-[10px] border border-dashed border-stone-300 bg-white px-4 py-10 text-center">
      <p className="text-[13px] font-medium text-stone-600">{title}</p>
      {hint ? <p className="mt-1 text-[12px] text-stone-400">{hint}</p> : null}
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
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 p-4 pt-[8vh]" onClick={onClose}>
      <div
        className={`w-full rounded-xl border border-stone-200 bg-white shadow-xl ${wide ? "max-w-3xl" : "max-w-xl"}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-stone-200 px-4 py-2.5">
          <h3 className="text-[14px] font-semibold text-stone-900">{title}</h3>
          <button onClick={onClose} className="rounded p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-700" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

export const inputCls =
  "w-full rounded-md border border-stone-300 bg-white px-2 py-1.5 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500";

export const btnPrimary =
  "inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-2.5 py-1.5 text-[13px] font-medium text-white hover:bg-brand-700 disabled:opacity-50";

export const btnSecondary =
  "inline-flex items-center gap-1.5 rounded-md border border-stone-300 bg-white px-2.5 py-1.5 text-[13px] font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-50";

export const btnDanger =
  "inline-flex items-center gap-1.5 rounded-md border border-red-200 bg-white px-2.5 py-1.5 text-[13px] font-medium text-red-700 hover:bg-red-50 disabled:opacity-50";
