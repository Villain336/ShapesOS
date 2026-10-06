// Marketr — Phase 16 slice 4: shared-state widgets (agent surfaces).
//
// Read the CoAgents shared state (useSharedState) and render the three
// domains: mission progress, approval queue summary, content calendar rows.
// House law: Agentic OS (docs/design/DESIGN.md) — tokens only, Lucide icons,
// dense tables for lists. Status shapes only on agent states (mission
// status, an approval waiting on you); everything else is a text chip.
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
  "rounded-md bg-paper text-ink shadow-hairline";
const tabBase =
  "flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[0.75rem] font-semibold";
const tabActive = "bg-ink text-paper";
const tabInactive = "text-muted hover:bg-hover-paper hover:text-ink";
const tableCls = "w-full text-left text-[0.8125rem]";
const thCls = "px-3 py-2 text-xs font-semibold text-muted";
const tdCls = "px-3 py-2 align-top";
const rowCls = "border-t border-line hover:bg-hover-paper";

function badgeCls(tone: "brand" | "stone" | "amber" | "green" | "red"): string {
  // Tones collapse to neutral chips; meaning comes from the label (and, for
  // agent states, the status shape — see StatusChip).
  const tones: Record<string, string> = {
    brand: "text-ink",
    stone: "text-muted",
    amber: "text-ink",
    green: "text-ink",
    red: "text-failed-text",
  };
  return `inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-canvas px-2 py-0.5 text-[0.75rem] font-semibold ${tones[tone]}`;
}

/** Agent-state shapes (DESIGN.md): only where the status is a run or a wait on the user. */
const MISSION_SHAPE: Record<string, string> = {
  active: "aos-shape aos-shape--running aos-is-live",
  pending: "aos-shape aos-shape--queued",
  scheduled: "aos-shape aos-shape--queued",
  complete: "aos-shape aos-shape--done",
  failed: "aos-shape aos-shape--failed",
  paused: "aos-shape aos-shape--paused",
};
const APPROVAL_SHAPE: Record<string, string> = {
  pending: "aos-shape aos-shape--needs aos-shape--edged",
};

function StatusChip({ status, kind }: { status: string; kind?: "mission" | "approval" }) {
  const shape = kind === "mission" ? MISSION_SHAPE[status] : kind === "approval" ? APPROVAL_SHAPE[status] : undefined;
  return (
    <span className={badgeCls(statusTone(status))}>
      {shape && <span className={`${shape} [--aos-shape-size:9px]`} aria-hidden="true" />}
      {status}
    </span>
  );
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
      <CircleDashed size={18} className="mx-auto text-subtle" />
      <p className="mt-2 text-[0.75rem] text-muted">{label}</p>
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
        <StatusChip status={mission.status} kind="mission" />
        <span className="text-[0.6875rem] text-muted">{mission.template}</span>
        <span className="ml-auto text-[0.75rem] font-semibold text-ink">{pct}%</span>
      </div>
      <p className="mt-2 text-[0.8125rem] font-medium text-ink">{mission.goal}</p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-canvas">
        <div className="h-full rounded-full bg-ink" style={{ width: `${pct}%` }} />
      </div>
      {mission.checkpoints.length > 0 && (
        <ul className="mt-2 space-y-1">
          {mission.checkpoints.slice(-4).map((c, i) => (
            <li key={i} className="flex items-center gap-1.5 text-[0.75rem] text-muted">
              <CheckCircle2 size={12} className="shrink-0 text-ink" />
              <span className="truncate">{c.label}</span>
              {c.at && <span className="ml-auto shrink-0 text-[0.6875rem] text-muted">{fmtDateTime(c.at)}</span>}
            </li>
          ))}
        </ul>
      )}
      {mission.lastEvent && (
        <p className="mt-2 text-[0.6875rem] text-muted">
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
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Inbox size={14} className="text-ink" />
        <span className="text-[0.75rem] font-semibold text-ink">
          {approvals.pendingCount} pending
        </span>
        <span className="ml-auto text-[0.6875rem] text-muted">
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
                <td className={`${tdCls} max-w-[220px] truncate text-ink`} title={item.title}>
                  {item.title}
                </td>
                <td className={tdCls}>
                  <StatusChip status={item.status} kind="approval" />
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
        className="inline-flex h-7 items-center rounded-full px-2.5 text-[0.75rem] font-semibold text-ink hover:bg-hover-paper disabled:opacity-40"
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
        className="h-8 rounded-md border-[1.5px] border-control bg-paper px-1.5 text-[0.75rem] text-ink focus:border-focus focus:outline-none"
      />
      <select
        value={draftStatus}
        onChange={(e) => setDraftStatus(e.target.value)}
        className="h-8 rounded-md border-[1.5px] border-control bg-paper px-1.5 text-[0.75rem] text-ink focus:border-focus focus:outline-none"
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
          className="inline-flex h-7 items-center rounded-full bg-ink px-3 text-[0.75rem] font-semibold text-paper hover:bg-ink-hover"
        >
          Save
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="inline-flex h-7 items-center rounded-full bg-paper px-3 text-[0.75rem] font-semibold text-ink shadow-outline hover:bg-hover-paper"
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
        <thead className="sticky top-0 bg-paper">
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
              <td className={`${tdCls} whitespace-nowrap text-muted`}>
                {fmtDateTime(row.scheduledFor)}
              </td>
              <td className={`${tdCls} max-w-[200px] truncate text-ink`} title={row.text}>
                {row.text || "—"}
              </td>
              <td className={tdCls}>
                <span className="text-[0.75rem] text-muted">
                  {row.channels.length > 0 ? row.channels.join(", ") : "—"}
                </span>
              </td>
              <td className={tdCls}>
                <StatusChip status={row.status} />
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
      <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
        {tabs.map(({ id, label, Icon, count }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            aria-pressed={tab === id}
            className={`${tabBase} ${tab === id ? tabActive : tabInactive}`}
          >
            <Icon size={13} />
            {label}
            {count !== undefined && count > 0 && (
              <span className={`rounded-full px-1.5 text-[0.6875rem] font-semibold ${tab === id ? "bg-paper text-ink" : "bg-ink text-paper"}`}>
                {count}
              </span>
            )}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-1 pr-1 text-[0.6875rem] text-muted" title="Shared state sync status">
          <RefreshCw size={10} className={isReady ? "text-ink" : ""} />
          {isReady ? "Synced" : "Connecting"}
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
        <div className="mb-2 w-[380px] max-w-[calc(100vw-2rem)] rounded-md shadow-raised">
          <SharedStatePanel />
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex h-9 items-center gap-2 rounded-full bg-paper px-3 text-[0.8125rem] font-semibold text-ink shadow-raised hover:shadow-outline"
      >
        <span className={`h-2 w-2 rounded-full ${isReady ? "bg-ink" : "bg-line-strong"}`} />
        Agent state
        {missionPct !== null && <span className="text-muted">{missionPct}%</span>}
        {pending > 0 && (
          <span className="flex items-center gap-1 rounded-full bg-canvas px-1.5 text-[0.6875rem] font-semibold text-ink" title="Approvals waiting on you">
            <Inbox size={11} />
            {pending}
          </span>
        )}
      </button>
    </div>
  );
}
