// Marketr — Phase 13D: shared client atoms for the Voice dashboard.
// Agentic OS visual language: black pills, white secondary with
// shadow-outline, token inputs, neutral chips for provider/workflow states.
"use client";

import type { ReactNode } from "react";

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

// Consent states, call statuses, and script states are workflow/document
// states, not agent states — always a neutral chip. The tone prop stays so
// existing call sites don't churn; it no longer changes the rendering.
export function Chip({
  children,
  tone = "slate",
}: {
  children: ReactNode;
  tone?: "slate" | "brand" | "green" | "amber" | "red" | "blue";
}) {
  void tone;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-1.5 py-0.5 text-[10px] font-medium leading-tight text-muted shadow-control">
      {children}
    </span>
  );
}

// Kept for call-site compatibility; every workflow state maps to neutral.
export function statusTone(_status: string): "slate" {
  return "slate";
}

export const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";

export const btnPrimary =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover disabled:opacity-40";

export const btnGhost =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-40";

export const btnDanger =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-failed-text shadow-[inset_0_0_0_1.5px_var(--aos-failed)] aos-press hover:bg-failed-tint disabled:opacity-40";

// Approve (an approval) → done fill, white text.
export const btnApprove =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-done px-4 text-sm font-semibold text-white aos-press hover:opacity-90 disabled:opacity-40";

// Review / submit-for-review → needs fill, black text.
export const btnReview =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-needs px-4 text-sm font-semibold text-ink aos-press hover:opacity-90 disabled:opacity-40";

export const tableCls = "w-full text-left text-[13px]";
export const theadCls = "border-b border-line text-[11px] font-medium text-muted";
export const thCls = "px-3 py-2";
export const rowCls = "border-b border-line hover:bg-hover-paper";
export const tdCls = "px-3 py-2 text-muted";

/** Sub-nav tabs for the Voice section (voice | sessions | scripts | consent). */
export function VoiceTabs({ active }: { active: string }) {
  const tabs = [
    { id: "agents", label: "Agents", href: "/dashboard/voice" },
    { id: "sessions", label: "Sessions", href: "/dashboard/voice/sessions" },
    { id: "scripts", label: "Scripts", href: "/dashboard/voice/scripts" },
    { id: "consent", label: "Consent", href: "/dashboard/voice/consent" },
  ];
  return (
    <div className="flex gap-1 border-b border-line">
      {tabs.map((t) => (
        <a
          key={t.id}
          href={t.href}
          className={`px-3 py-2 text-[13px] font-medium ${
            active === t.id
              ? "border-b-2 border-ink text-ink"
              : "text-muted hover:text-ink"
          }`}
        >
          {t.label}
        </a>
      ))}
    </div>
  );
}

/** Info note strip (border-line bg-paper per house pattern). */
export function Note({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-line bg-paper px-3 py-2 text-[12px] text-muted">
      {children}
    </div>
  );
}
