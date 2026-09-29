// Marketr — Phase 16 slice 4: shared-state widgets (agent surfaces).
//
// Read the CoAgents shared state (useSharedState) and render the three
// domains: mission progress, approval queue summary, content calendar rows.
// House law: brand vars (never hardcoded primary), Lucide icons, dense
// tables for lists (mirrors app/dashboard/studio/StudioApp.tsx patterns:
// text-[13px] rows, badge columns, hover:bg-[var(--brand-50)]/40).
//
// Editing: only content-calendar rows are editable here (scheduledFor /
// status). Edits call agent.setState (optimistic UI→agent); the backend
// persists them on the next run and re-emits the canonical snapshot.
// Approvals stay read-only — approve/deny/edit live in the slice-3
// approval card behind the Phase 14 gate.

"use client";

import { useState } from "react";
import {
  CalendarDays,
  CheckCircle2,
  CircleDashed,
  Inbox,
  Rocket,
  RefreshCw,
} from "lucide-react";
import { useSharedState } from "./use-shared-state";
import type {
  ApprovalQueueState,
  ContentCalendarState,
  MissionSharedState,
} from "@/lib/agents/agui/shared-state";

const panelCls =
  "rounded-[10px] border border-stone-200 bg-white text-stone-900";
const tabBase =
  "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium text-stone-500 hover:text-stone-800";
const tabActive =
  "border border-[var(--brand-600)] text-[var(--brand-700)] bg-[var(--brand-50)]/40";
const tableCls = "w-full text-left text-[13px]";
const thCls = "px-3 py-2 font-medium text-stone-500 text-[11px] uppercase tracking-wide";
const tdCls = "px-3 py-2 align-top";
const rowCls = "border-t border-stone-100 hover:bg-[var(--brand-50)]/40";

function badgeCls(tone: "brand" | "stone" | "amber" | "green" | "red"): string {
  const tones: Record<string, string> = {
    brand: "bg-[var(--brand-50)] text-[var(--brand-700)] border-[var(--brand-600)]/20",
    stone: "bg-stone-100 text-stone-600 border-stone-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    green: "bg-emerald-50 text-emerald-700 border-emerald-200",
    red: "bg-red-50 text-red-700 border-red-200",
  };
  return `inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`;
}

function statusTone(status: string): "brand" | "stone" | "amber" | "green" | "red" {
  switch (status) {
    case "active":
    case "scheduled":
    case "pending":
      return "brand";
    case "complete":
    case "sent":
    case "approved":
      return "green";
    case "paused":
    case "draft":
      return "amber";
    case "failed":
    case "denied":
      return "red";
    default:
      return "stone";
  }
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** datetime-local value (YYYY-MM-DDTHH:mm) from an ISO string. */
function toDateTimeLocal(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="px-4 py-8 text-center">
      <CircleDashed size={18} className="mx-auto text-stone-300" />
      <p className="mt-2 text-[12px] text-stone-500">{label}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mission progress
// ---------------------------------------------------------------------------

export function MissionProgressWidget({ mission }: { mission?: MissionSharedState | null }) {
  if (!mission) return <EmptyState label="No active mission — start one and it appears here." />;
  const pct = Math.round(mission.progress * 100);
  return (
    <div className="p-3">
      <div className="flex items-center gap-2">
        <span className={badgeCls(statusTone(mission.status))}>{mission.status}</span>
        <span className="text-[11px] text-stone-400">{mission.template}</span>
        <span className="ml-auto text-[12px] font-semibold text-stone-700">{pct}%</span>
      </div>
      <p className="mt-2 text-[13px] font-medium text-stone-800">{mission.goal}</p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-stone-100">
        <div className="h-full rounded-full bg-[var(--brand-600)]" style={{ width: `${pct}%` }} />
      </div>
      {mission.checkpoints.length > 0 && (
        <ul className="mt-2 space-y-1">
          {mission.checkpoints.slice(-4).map((c, i) => (
            <li key={i} className="flex items-center gap-1.5 text-[12px] text-stone-600">
              <CheckCircle2 size={12} className="shrink-0 text-[var(--brand-600)]" />
              <span className="truncate">{c.label}</span>
              {c.at && <span className="ml-auto shrink-0 text-[11px] text-stone-400">{fmtDateTime(c.at)}</span>}
            </li>
          ))}
        </ul>
      )}
      {mission.lastEvent && (
        <p className="mt-2 text-[11px] text-stone-400">
          Last: {mission.lastEvent.tool ?? mission.lastEvent.step ?? "event"} ·{" "}
          {fmtDateTime(mission.lastEvent.at)}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Approval queue summary (read-only — the gate card does the actions)
// ---------------------------------------------------------------------------

export function ApprovalQueueWidget({ approvals }: { approvals?: ApprovalQueueState }) {
  if (!approvals || approvals.items.length === 0) {
    return <EmptyState label="Approval queue is empty." />;
  }
  return (
    <div>
      <div className="flex items-center gap-2 border-b border-stone-200 px-3 py-2">
        <Inbox size={14} className="text-[var(--brand-600)]" />
        <span className="text-[12px] font-semibold text-stone-700">
          {approvals.pendingCount} pending
        </span>
        <span className="ml-auto text-[11px] text-stone-400">
          updated {fmtDateTime(approvals.updatedAt)}
        </span>
      </div>
      <div className="max-h-64 overflow-y-auto">
        <table className={tableCls}>
          <thead>
            <tr>
              <th className={thCls}>Kind</th>
              <th className={thCls}>Item</th>
              <th className={thCls}>Status</th>
            </tr>
          </thead>
          <tbody>
            {approvals.items.map((item) => (
              <tr key={item.id} className={rowCls}>
                <td className={tdCls}>
                  <span className={badgeCls("stone")}>{item.kind.replace(/_/g, " ")}</span>
                </td>
                <td className={`${tdCls} max-w-[220px] truncate text-stone-800`} title={item.title}>
                  {item.title}
                </td>
                <td className={tdCls}>
                  <span className={badgeCls(statusTone(item.status))}>{item.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Content calendar (editable scheduledFor / status → agent.setState)
// ---------------------------------------------------------------------------

const CALENDAR_STATUSES = ["draft", "scheduled", "cancelled"] as const;

function CalendarRowEditor({
  rowId,
  scheduledFor,
  status,
}: {
  rowId: string;
  scheduledFor: string | null;
  status: string;
}) {
  const { updateCalendarRow, isReady } = useSharedState();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(toDateTimeLocal(scheduledFor));
  const [draftStatus, setDraftStatus] = useState(
    (CALENDAR_STATUSES as readonly string[]).includes(status) ? status : "draft",
  );

  if (!editing) {
    return (
      <button
        type="button"
        disabled={!isReady}
        onClick={() => {
          setDraft(toDateTimeLocal(scheduledFor));
          setEditing(true);
        }}
        className="text-[11px] font-medium text-[var(--brand-700)] hover:underline disabled:opacity-40"
      >
        Edit
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <input
        type="datetime-local"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="rounded-md border border-stone-200 px-1.5 py-1 text-[12px]"
      />
      <select
        value={draftStatus}
        onChange={(e) => setDraftStatus(e.target.value)}
        className="rounded-md border border-stone-200 px-1.5 py-1 text-[12px]"
      >
        {CALENDAR_STATUSES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={() => {
            const iso = draft ? new Date(draft).toISOString() : null;
            updateCalendarRow(rowId, { scheduledFor: iso, status: draftStatus });
            setEditing(false);
          }}
          className="rounded-md bg-[var(--brand-600)] px-2 py-1 text-[11px] font-medium text-white hover:bg-[var(--brand-700)]"
        >
          Save
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="rounded-md border border-stone-200 px-2 py-1 text-[11px] text-stone-500"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export function ContentCalendarWidget({ calendar }: { calendar?: ContentCalendarState }) {
  if (!calendar || calendar.rows.length === 0) {
    return <EmptyState label="No calendar rows yet — schedule a post and it appears here." />;
  }
  return (
    <div className="max-h-72 overflow-y-auto">
      <table className={tableCls}>
        <thead className="sticky top-0 bg-white">
          <tr>
            <th className={thCls}>Scheduled</th>
            <th className={thCls}>Post</th>
            <th className={thCls}>Channels</th>
            <th className={thCls}>Status</th>
            <th className={thCls} />
          </tr>
        </thead>
        <tbody>
          {calendar.rows.map((row) => (
            <tr key={row.id} className={rowCls}>
              <td className={`${tdCls} whitespace-nowrap text-stone-600`}>
                {fmtDateTime(row.scheduledFor)}
              </td>
              <td className={`${tdCls} max-w-[200px] truncate text-stone-800`} title={row.text}>
                {row.text || "—"}
              </td>
              <td className={tdCls}>
                <span className="text-[12px] text-stone-500">
                  {row.channels.length > 0 ? row.channels.join(", ") : "—"}
                </span>
              </td>
              <td className={tdCls}>
                <span className={badgeCls(statusTone(row.status))}>{row.status}</span>
              </td>
              <td className={tdCls}>
                <CalendarRowEditor rowId={row.id} scheduledFor={row.scheduledFor} status={row.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel (tabbed) + dock (sidebar variant)
// ---------------------------------------------------------------------------

type TabId = "mission" | "approvals" | "calendar";

export function SharedStatePanel() {
  const { state, isReady } = useSharedState();
  const [tab, setTab] = useState<TabId>("mission");
  const pending = state.approvals?.pendingCount ?? 0;

  const tabs: Array<{ id: TabId; label: string; Icon: typeof Rocket; count?: number }> = [
    { id: "mission", label: "Mission", Icon: Rocket },
    { id: "approvals", label: "Approvals", Icon: Inbox, count: pending },
    { id: "calendar", label: "Calendar", Icon: CalendarDays },
  ];

  return (
    <div className={panelCls} data-testid="shared-state-panel">
      <div className="flex items-center gap-1 border-b border-stone-200 px-2 py-1.5">
        {tabs.map(({ id, label, Icon, count }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`${tabBase} ${tab === id ? tabActive : "border border-transparent"}`}
          >
            <Icon size={13} />
            {label}
            {count !== undefined && count > 0 && (
              <span className="rounded-full bg-[var(--brand-600)] px-1.5 text-[10px] font-semibold text-white">
                {count}
              </span>
            )}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-1 pr-1 text-[10px] text-stone-400" title="Shared state sync status">
          <RefreshCw size={10} className={isReady ? "text-[var(--brand-600)]" : ""} />
          {isReady ? "synced" : "connecting"}
        </span>
      </div>
      {tab === "mission" && <MissionProgressWidget mission={state.mission} />}
      {tab === "approvals" && <ApprovalQueueWidget approvals={state.approvals} />}
      {tab === "calendar" && <ContentCalendarWidget calendar={state.calendar} />}
    </div>
  );
}

/**
 * Compact dock for the sidebar variant: a floating summary that expands
 * into the full panel. Lives bottom-left so it never collides with the
 * CopilotSidebar toggle (bottom-right).
 */
export function SharedStateDock() {
  const { state, isReady } = useSharedState();
  const [open, setOpen] = useState(false);
  const pending = state.approvals?.pendingCount ?? 0;
  const missionPct = state.mission ? Math.round(state.mission.progress * 100) : null;

  return (
    <div className="fixed bottom-4 left-4 z-40" data-testid="shared-state-dock">
      {open && (
        <div className="mb-2 w-[380px] max-w-[calc(100vw-2rem)] shadow-lg">
          <SharedStatePanel />
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-full border border-stone-200 bg-white px-3 py-2 text-[12px] font-medium text-stone-700 shadow-md hover:border-[var(--brand-600)]"
      >
        <span className={`h-2 w-2 rounded-full ${isReady ? "bg-[var(--brand-600)]" : "bg-stone-300"}`} />
        Agent state
        {missionPct !== null && <span className="text-stone-400">{missionPct}%</span>}
        {pending > 0 && (
          <span className="flex items-center gap-1 rounded-full bg-[var(--brand-50)] px-1.5 text-[11px] font-semibold text-[var(--brand-700)]">
            <Inbox size={11} />
            {pending}
          </span>
        )}
      </button>
    </div>
  );
}
