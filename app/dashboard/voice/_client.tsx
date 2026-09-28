// Marketr — Phase 13D: shared client atoms for the Voice dashboard.
// Mirrors the StudioApp patterns class-by-class (AGENTS.md), but with the
// brand law applied: --brand-600/700/50 vars only, never hardcoded primary.
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

export function Chip({
  children,
  tone = "slate",
}: {
  children: ReactNode;
  tone?: "slate" | "brand" | "green" | "amber" | "red" | "blue";
}) {
  const tones: Record<string, string> = {
    slate: "bg-stone-100 text-stone-600 border-stone-200",
    brand: "bg-[var(--brand-50)] text-[var(--brand-700)] border-[var(--brand-600)]/20",
    green: "bg-emerald-50 text-emerald-700 border-emerald-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    red: "bg-red-50 text-red-700 border-red-200",
    blue: "bg-sky-50 text-sky-700 border-sky-200",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-tight ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function statusTone(status: string): "slate" | "brand" | "green" | "amber" | "red" | "blue" {
  switch (status) {
    case "rehearsal":
      return "blue";
    case "queued":
      return "amber";
    case "in_progress":
      return "blue";
    case "completed":
    case "approved":
    case "opted_in":
      return "green";
    case "blocked":
    case "rejected":
    case "opted_out":
      return "red";
    case "in_review":
    case "pending":
      return "amber";
    case "draft":
    case "cancelled":
    case "unknown":
      return "slate";
    default:
      return "slate";
  }
}

export const inputCls =
  "rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-[var(--brand-600)] focus:outline-none";

export const btnPrimary =
  "inline-flex items-center gap-1.5 rounded-md bg-[var(--brand-600)] px-3 py-1.5 text-[13px] font-medium text-white hover:bg-[var(--brand-700)] disabled:opacity-40";

export const btnGhost =
  "inline-flex items-center gap-1.5 rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-700 hover:bg-stone-50 disabled:opacity-40";

export const btnDanger =
  "inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-red-700 disabled:opacity-40";

export const tableCls = "w-full text-left text-[13px]";
export const theadCls =
  "border-b border-stone-200 text-[11px] font-medium uppercase tracking-wide text-stone-500";
export const thCls = "px-3 py-2";
export const rowCls = "border-b border-stone-100 hover:bg-[var(--brand-50)]/40";
export const tdCls = "px-3 py-2 text-stone-700";

/** Sub-nav tabs for the Voice section (voice | sessions | scripts | consent). */
export function VoiceTabs({ active }: { active: string }) {
  const tabs = [
    { id: "agents", label: "Agents", href: "/dashboard/voice" },
    { id: "sessions", label: "Sessions", href: "/dashboard/voice/sessions" },
    { id: "scripts", label: "Scripts", href: "/dashboard/voice/scripts" },
    { id: "consent", label: "Consent", href: "/dashboard/voice/consent" },
  ];
  return (
    <div className="flex gap-1 border-b border-stone-200">
      {tabs.map((t) => (
        <a
          key={t.id}
          href={t.href}
          className={`px-3 py-2 text-[13px] font-medium ${
            active === t.id
              ? "border-b-2 border-[var(--brand-600)] text-[var(--brand-700)]"
              : "text-stone-500 hover:text-stone-800"
          }`}
        >
          {t.label}
        </a>
      ))}
    </div>
  );
}

/** Info note strip (border-stone-200 bg-stone-50 per house pattern). */
export function Note({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-[12px] text-stone-600">
      {children}
    </div>
  );
}
