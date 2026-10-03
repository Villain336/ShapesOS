// Marketr CRM — visual atoms (Agentic OS).
// Visual migration only: same layout, same behavior, token classes only.
// Workflow states (lead stages, invoice/PO/project statuses, stock levels,
// activity types, call outcomes) render as NEUTRAL chips — they are never
// agent states. Genuine agent run states (workflows) use the color+shape
// language via RunStatusChip / StepStatusChip.

"use client";

import { Users, type LucideIcon } from "lucide-react";
import { initials } from "./types";

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

/** Primary action: black pill. */
export const btnPrimary =
  "inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-ink px-4 py-[7px] text-[13px] font-semibold text-white aos-press hover:bg-night-hover focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:cursor-not-allowed disabled:opacity-40";

/** Small primary, for inline/dense contexts. */
export const btnPrimarySm =
  "inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-ink px-2.5 py-1 text-[12px] font-semibold text-white aos-press hover:bg-night-hover focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:cursor-not-allowed disabled:opacity-40";

/** Secondary action: white pill with outline shadow. */
export const btnGhost =
  "inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-paper px-4 py-[7px] text-[13px] font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:cursor-not-allowed disabled:opacity-40";

/** Small secondary, for inline/dense contexts. */
export const btnGhostSm =
  "inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-paper px-2.5 py-1 text-[12px] font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:cursor-not-allowed disabled:opacity-40";

/** Destructive action (deny, void, cancel): failed text, failed ring. */
export const btnDeny =
  "inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-paper px-4 py-[7px] text-[13px] font-semibold text-failed-text aos-press shadow-[inset_0_0_0_1.5px_var(--aos-failed)] hover:bg-failed-tint focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:cursor-not-allowed disabled:opacity-40";

/** Small destructive, for inline/dense contexts. */
export const btnDenySm =
  "inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-paper px-2.5 py-1 text-[12px] font-semibold text-failed-text aos-press shadow-[inset_0_0_0_1.5px_var(--aos-failed)] hover:bg-failed-tint focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:cursor-not-allowed disabled:opacity-40";

/** Approves an agent-prepared action: done green (genuine agent state). */
export const btnApprove =
  "inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-done px-4 py-[7px] text-[13px] font-semibold text-white aos-press focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:cursor-not-allowed disabled:opacity-40";

/** Requests human review of an agent-prepared action: needs yellow. */
export const btnReview =
  "inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-needs px-4 py-[7px] text-[13px] font-semibold text-ink aos-press hover:brightness-95 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:cursor-not-allowed disabled:opacity-40";

/** Executes an approved action (irreversible send): running blue. */
export const btnExecute =
  "inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-running px-4 py-[7px] text-[13px] font-semibold text-white aos-press hover:brightness-110 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:cursor-not-allowed disabled:opacity-40";

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------

export const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-[13px] text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none disabled:opacity-50";

export const selectCls =
  "h-control-sm cursor-pointer rounded-md border-[1.5px] border-control bg-paper px-3 text-[13px] text-ink focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none disabled:opacity-50";

export const labelCls = "mb-1 block text-xs font-semibold text-muted";

/** Section heading inside slide-overs (sentence case, never eyebrow). */
export const sectionTitleCls = "mb-2.5 text-[13px] font-bold text-ink";

// ---------------------------------------------------------------------------
// Chips, tabs, tables, kanban
// ---------------------------------------------------------------------------

/** Neutral chip for workflow states. */
export const chipCls =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-canvas px-2 py-0.5 text-[11px] font-semibold text-ink";

export function tabCls(active: boolean): string {
  return `inline-flex items-center gap-1.5 border-b-2 px-1 py-2 text-[13px] font-semibold ${
    active ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink"
  }`;
}

/** Dense table wrapper + atoms. */
export const tableWrapCls = "overflow-x-auto rounded-lg border border-line bg-paper";
export const tableCls = "w-full text-left text-[13px]";
export const thCls =
  "whitespace-nowrap border-b border-line bg-canvas px-3 py-2 text-left text-[11px] font-semibold text-muted";
export const tdCls = "border-b border-line px-3 py-2 align-middle text-[13px] text-ink";
export const trClickableCls = "cursor-pointer hover:bg-hover-paper";

export const kanbanColCls =
  "flex max-h-full w-[264px] min-w-[264px] flex-col rounded-lg border border-line bg-canvas";
/** Applied to a kanban column while a drag hovers it. */
export const kanbanColOverCls = "border-ink bg-hover-paper";
export const kanbanCardCls =
  "cursor-grab rounded-md border border-line bg-paper px-3 py-2.5 hover:border-control active:cursor-grabbing";

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

export const backdropCls = "fixed inset-0 z-[55] bg-ink/30";
export const slideoverCls =
  "fixed inset-y-0 right-0 z-[60] flex w-[560px] max-w-[94vw] flex-col border-l border-line-strong bg-paper shadow-overlay";
export const modalWrapCls =
  "fixed inset-0 z-[70] flex items-start justify-center px-4 pb-4 pt-[8vh]";
export const modalCardCls =
  "flex max-h-[84vh] w-[520px] max-w-full flex-col rounded-lg border border-line-strong bg-paper shadow-overlay";

// ---------------------------------------------------------------------------
// Message boxes
// ---------------------------------------------------------------------------

/** Error banner. */
export const errorBoxCls =
  "rounded-lg border border-failed bg-failed-tint px-3 py-2 text-[13px] text-failed-text";

/** Neutral info / "done" note box. */
export const noteBoxCls = "rounded-lg border border-line bg-canvas px-3 py-2 text-[13px] text-ink";

/** Neutral info card (gray info panels). */
export const infoBoxCls = "rounded-lg border border-line bg-canvas px-3 py-2.5 text-[13px] text-muted";

/** Attention banner — needs-tint, black text, edged triangle mark. */
export const needsBoxCls =
  "rounded-lg border border-needs bg-needs-tint px-4 py-3 text-[13px] text-ink";

// ---------------------------------------------------------------------------
// Neutral workflow-state primitives (kept API-compatible)
// ---------------------------------------------------------------------------

/** Neutral stage chip (the old crm-chip color prop is accepted but not rendered). */
export function StageBadge({ label, color }: { label: string; color: string }) {
  void color;
  return <span className={chipCls}>{label}</span>;
}

/** Segmented 5-bar score indicator — neutral ink. */
export function ScoreBar({ score, showNumber = true }: { score: number; showNumber?: boolean }) {
  const filled = Math.round(score / 20);
  return (
    <span className="inline-flex items-center gap-2">
      {showNumber && (
        <span className="w-7 text-[13px] font-semibold tabular-nums text-ink">{score}</span>
      )}
      <span className="inline-flex gap-[3px]" title={`Score ${score}`}>
        {[0, 1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className="h-[6px] w-[14px] rounded-full"
            style={{ background: i < filled ? "var(--aos-ink)" : "var(--aos-line)" }}
          />
        ))}
      </span>
    </span>
  );
}

/** Mini activity sparkline (8 weekly buckets) — neutral ink. */
export function Sparkline({ data, width = 72, height = 24 }: { data: number[]; width?: number; height?: number }) {
  const max = Math.max(1, ...data);
  const pts = data
    .map((v, i) => `${(i / (data.length - 1)) * width},${height - (v / max) * (height - 4) - 2}`)
    .join(" ");
  return (
    <svg width={width} height={height} className="overflow-visible" aria-hidden>
      <polyline
        points={pts}
        fill="none"
        stroke="var(--aos-ink)"
        strokeWidth="1.8"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {data.map((v, i) =>
        v > 0 ? (
          <circle
            key={i}
            cx={(i / (data.length - 1)) * width}
            cy={height - (v / max) * (height - 4) - 2}
            r="1.6"
            fill="var(--aos-ink)"
          />
        ) : null,
      )}
    </svg>
  );
}

/** Mini bar chart (slide-over activity trend) — neutral ink. */
export function MiniBars({ data, width = 220, height = 56 }: { data: number[]; width?: number; height?: number }) {
  const max = Math.max(1, ...data);
  const bw = width / data.length;
  return (
    <svg width={width} height={height} aria-hidden>
      {data.map((v, i) => {
        const h = Math.max(2, (v / max) * (height - 8));
        return (
          <rect
            key={i}
            x={i * bw + 2}
            y={height - h}
            width={bw - 4}
            height={h}
            rx={2}
            fill={i === data.length - 1 ? "var(--aos-ink)" : "var(--aos-line)"}
          />
        );
      })}
    </svg>
  );
}

/** Black letter tile. */
export function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-ink font-semibold text-white"
      style={{ width: size, height: size, fontSize: size * 0.38 }}
      title={name}
    >
      {initials(name)}
    </span>
  );
}

export function EmptyState({
  title,
  hint,
  icon: Icon = Users,
}: {
  title: string;
  hint: string;
  icon?: LucideIcon;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-canvas text-ink">
        <Icon size={22} />
      </div>
      <p className="text-sm font-semibold text-ink">{title}</p>
      <p className="mt-1 max-w-xs text-[13px] text-muted">{hint}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Genuine agent-state badges (color + shape language)
// ---------------------------------------------------------------------------

const runChipBase =
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-canvas px-2 py-0.5 text-[11px] font-semibold text-ink";

/** Genuine agent run state: workflow run status. */
export function RunStatusChip({ status }: { status: string }) {
  if (status === "running") {
    return (
      <span className={runChipBase}>
        <span className="aos-shape aos-shape--running aos-is-live" role="img" aria-label="Running" />
        Running
      </span>
    );
  }
  if (status === "succeeded") {
    return (
      <span className={runChipBase}>
        <span className="aos-shape aos-shape--done" role="img" aria-label="Succeeded" />
        Succeeded
      </span>
    );
  }
  if (status === "failed" || status === "compensated") {
    return (
      <span className={runChipBase}>
        <span className="aos-shape aos-shape--failed" role="img" aria-label={status === "failed" ? "Failed" : "Compensated"} />
        {status === "failed" ? "Failed — needs attention" : "Failed — compensated"}
      </span>
    );
  }
  return <span className={chipCls}>{status}</span>;
}

/** Genuine agent run state: workflow step status. */
export function StepStatusChip({ status }: { status: string }) {
  const label =
    status === "done"
      ? "Done"
      : status === "pending"
        ? "Pending"
        : status === "running"
          ? "Running"
          : status === "failed"
            ? "Failed"
            : status === "compensated"
              ? "Compensated"
              : status;
  const shape =
    status === "pending"
      ? "aos-shape aos-shape--queued"
      : status === "running"
        ? "aos-shape aos-shape--running aos-is-live"
        : status === "done"
          ? "aos-shape aos-shape--done"
          : status === "failed" || status === "compensated"
            ? "aos-shape aos-shape--failed"
            : null;
  if (!shape) return <span className={chipCls}>{label}</span>;
  return (
    <span className={runChipBase}>
      <span className={shape} role="img" aria-label={label} />
      {label}
    </span>
  );
}
