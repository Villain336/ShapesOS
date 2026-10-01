// Marketr — Phase 16 slice 6: run viewer (timeline + replay + video + trace).
//
// /dashboard/runs/[runId] — the viewable-agent-run surface (spec §5).
// All data loads through the slice-5 service (workspace-scoped, RLS
// fail-closed): a run from another workspace reads as null → notFound().
// Artifacts stream through the scoped API route — the page only ever
// builds route URLs, never filesystem paths.
// Approval actions live in /dashboard/approvals (slice 3 flow); this page
// only links out.

import Link from "next/link";
import {
  ArrowLeft,
  Clock,
  Download,
  Film,
  Globe,
  ListOrdered,
  Monitor,
  Radio,
  ShieldCheck,
  StickyNote,
  Video,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { notFound } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { getAgentRun, listAgentRunEvents } from "@/lib/agents/runs/service";
import type { AgentRunEventType, AgentRunStatus } from "@/lib/agents/runs/types";
import { LiveWatch } from "./LiveWatch";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Agent run — Marketr",
  description: "Watch the agent work: event timeline, recording, and trace.",
};

const EVENT_ICON: Record<AgentRunEventType, LucideIcon> = {
  agui: Zap,
  gate: ShieldCheck,
  browser: Monitor,
  note: StickyNote,
};

// Run statuses are genuine agent states → status color + shape + text label.
// Cancelled has no status color in the system — it renders as a neutral chip.
function RunStatusBadge({ status }: { status: AgentRunStatus }) {
  const base =
    "inline-flex h-badge items-center gap-1.5 rounded-full px-3 text-sm font-semibold";
  const shape = (extra: string) => (
    <span className={`aos-shape ${extra}`} style={{ color: "inherit" }} aria-hidden />
  );
  switch (status) {
    case "running":
      return (
        <span className={`${base} bg-running text-white`}>
          {shape("aos-shape--running aos-is-live")} Running
        </span>
      );
    case "succeeded":
      return (
        <span className={`${base} bg-done text-white`}>
          {shape("aos-shape--done")} Succeeded
        </span>
      );
    case "failed":
      return (
        <span className={`${base} bg-failed text-white`}>
          {shape("aos-shape--failed")} Failed
        </span>
      );
    case "queued":
      return (
        <span className={`${base} bg-paper text-ink shadow-outline`}>
          {shape("aos-shape--queued")} Queued
        </span>
      );
    default:
      return (
        <span className="inline-flex h-badge items-center rounded-full bg-paper px-3 text-sm font-semibold text-muted shadow-control">
          Cancelled
        </span>
      );
  }
}

// Event types are categories, not agent states — neutral chips.
function EventTypeChip({ type }: { type: AgentRunEventType }) {
  const Icon = EVENT_ICON[type] ?? StickyNote;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-paper px-2 py-0.5 text-xs font-semibold text-muted shadow-control">
      <Icon className="size-3" aria-hidden />
      {type}
    </span>
  );
}

function Section({
  title,
  description,
  actions,
  children,
  bodyClassName,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  bodyClassName?: string;
}) {
  return (
    <section className="rounded-lg bg-paper shadow-hairline">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div>
          <h2 className="aos-subheading">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
        </div>
        {actions}
      </div>
      <div className={bodyClassName ?? "p-4"}>{children}</div>
    </section>
  );
}

function StatTile({
  label,
  value,
  icon,
}: {
  label: string;
  value: React.ReactNode;
  icon: React.ReactNode;
}) {
  return (
    <div className="rounded-lg bg-paper p-3 shadow-hairline">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-muted">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-lg font-bold tabular-nums text-ink">{value}</div>
    </div>
  );
}

const btnPrimary =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover";

const btnSecondary =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper";

function fmtDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function fmtBytes(bytes: number | bigint): string {
  const n = Number(bytes);
  if (!n) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtTime(d: Date): string {
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Readable payload rendering: scalars as rows, objects in <details>. */
function PayloadView({ payload }: { payload: unknown }) {
  if (payload == null || typeof payload !== "object") return null;
  const entries = Object.entries(payload as Record<string, unknown>);
  if (entries.length === 0) return null;
  return (
    <div className="mt-1.5 space-y-1">
      {entries.map(([key, value]) => {
        if (value == null || typeof value === "object") {
          return (
            <details key={key} className="text-xs text-muted">
              <summary className="cursor-pointer hover:text-ink">{key} (detail)</summary>
              <pre className="mt-1 max-h-48 overflow-auto rounded-md border border-line bg-canvas p-2 font-mono text-[11px] text-ink">
                {JSON.stringify(value, null, 2)}
              </pre>
            </details>
          );
        }
        return (
          <div key={key} className="flex gap-1.5 text-xs">
            <span className="shrink-0 font-medium text-muted">{key}:</span>
            <span className="min-w-0 truncate text-ink">{String(value)}</span>
          </div>
        );
      })}
    </div>
  );
}

export default async function RunViewerPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const user = await requireUser();
  if (!user) return null; // layout already redirects
  const { runId } = await params;
  const workspace = await getOrCreateWorkspace(user.id, user.email);

  const run = await getAgentRun(workspace.id, runId);
  if (!run) notFound();

  const events = await listAgentRunEvents(workspace.id, runId);

  // Pending approvals for the run's mission — link out to the slice-3
  // approval flow (/dashboard/approvals). Actions happen there, never here.
  const pendingApprovals = run.missionId
    ? await withWorkspaceScope(workspace.id, (tx) =>
        tx.missionApproval.findMany({
          where: { missionId: run.missionId, status: "pending" },
          orderBy: { createdAt: "desc" },
          take: 25,
          select: { id: true, action: true, tier: true, createdAt: true },
        }),
      )
    : [];

  const recording = run.recording;
  const videoUrl = recording?.videoPath ? `/api/agent-runs/${run.id}/recording/video` : null;
  const traceUrl = recording?.tracePath ? `/api/agent-runs/${run.id}/recording/trace` : null;
  const endedAt = run.endedAt ?? new Date();
  const durationMs = endedAt.getTime() - run.createdAt.getTime();
  const browserEvents = events.filter((e) => e.type === "browser");
  const gateEvents = events.filter((e) => e.type === "gate");

  return (
    <div className="flex flex-col gap-6 bg-canvas p-4 md:p-6">
      <Link
        href="/dashboard"
        className="inline-flex items-center gap-1.5 self-start rounded-full px-3 py-2 text-sm font-semibold text-ink aos-press hover:bg-hover"
      >
        <ArrowLeft className="size-3.5" />
        Dashboard
      </Link>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="aos-heading">Agent run</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted">
            <RunStatusBadge status={run.status} />
            <span className="inline-flex h-badge items-center rounded-full bg-paper px-3 text-sm font-semibold text-muted shadow-control">
              {run.kind}
            </span>
            <span>started by {run.startedBy}</span>
            <span aria-hidden className="text-subtle">·</span>
            <span>{fmtTime(run.createdAt)}</span>
            {run.endedAt && (
              <>
                <span aria-hidden className="text-subtle">·</span>
                <span>ended {fmtTime(run.endedAt)}</span>
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {run.missionId && (
            <Link
              href={`/dashboard/missions/${run.missionId}`}
              className={btnSecondary}
            >
              Mission
            </Link>
          )}
          {run.threadId && (
            <span className="inline-flex items-center rounded-full bg-paper px-2 py-0.5 font-mono text-xs text-muted shadow-control">
              thread {run.threadId}
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Timeline events" value={events.length} icon={<ListOrdered className="size-4" />} />
        <StatTile label="Browser steps" value={recording?.stepCount ?? 0} icon={<Monitor className="size-4" />} />
        <StatTile label="Duration" value={fmtDuration(durationMs)} icon={<Clock className="size-4" />} />
        <StatTile label="Artifacts" value={fmtBytes(recording?.sizeBytes ?? 0)} icon={<Film className="size-4" />} />
      </div>

      {/* Slice 7: live watch — mounted ONLY while the run is running.
          Finished runs show the recorded video below instead. */}
      {run.status === "running" && <LiveWatch runId={run.id} />}

      {/* Recording: video + trace download. Bytes stream through the
          workspace-scoped API route; no filesystem paths reach the client. */}
      <Section
        title="Recording"
        description="Playwright video and trace for this run"
        actions={
          traceUrl ? (
            <a href={traceUrl} className={btnPrimary}>
              <Download className="size-3.5" />
              Download trace.zip
            </a>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-3">
          {videoUrl ? (
            <video controls preload="metadata" src={videoUrl} className="aspect-video w-full rounded-lg bg-black" />
          ) : (
            <p className="flex items-center gap-2 text-sm text-muted">
              <Video className="size-4" />
              No video was recorded for this run.
            </p>
          )}
          <p className="rounded-lg border border-line bg-canvas px-3 py-2 text-xs text-muted">
            Retention: videos are dropped 30 days after creation unless pinned; the trace is
            kept and summarized instead of deleted.
          </p>
        </div>
      </Section>

      {/* Step strip: DOM-snapshot strip from browser timeline events.
          Full frame-by-frame DOM replay = download the trace above. */}
      {browserEvents.length > 0 && (
        <Section
          title="Step strip"
          description="Browser steps in order — from timeline events"
          bodyClassName="p-3"
        >
          <ol className="flex gap-2 overflow-x-auto pb-1">
            {browserEvents.map((e) => (
              <li
                key={e.id}
                className="w-52 shrink-0 rounded-lg bg-paper p-2.5 shadow-hairline"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-muted">
                    Step {e.seq}
                  </span>
                  <span className="text-[11px] tabular-nums text-subtle">
                    +{fmtDuration(e.createdAt.getTime() - run.createdAt.getTime())}
                  </span>
                </div>
                <p className="mt-1 line-clamp-3 text-xs leading-snug text-ink">
                  {e.summary}
                </p>
              </li>
            ))}
          </ol>
          <p className="mt-2 text-xs text-muted">
            For frame-by-frame DOM replay, download the trace and open it in the Playwright
            trace viewer.
          </p>
        </Section>
      )}

      {/* Timeline: dense table, seq-ordered, typed with readable payloads. */}
      <Section
        title="Timeline"
        description={`${events.length} event${events.length === 1 ? "" : "s"}, in order`}
        bodyClassName="p-0"
      >
        {events.length === 0 ? (
          <p className="p-4 text-sm text-muted">No events yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs font-semibold text-muted">
                  <th className="w-14 px-3 py-2 font-semibold">Seq</th>
                  <th className="w-28 px-3 py-2 font-semibold">Type</th>
                  <th className="px-3 py-2 font-semibold">Event</th>
                  <th className="w-40 px-3 py-2 font-semibold">Time</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id} className="border-b border-line last:border-b-0 hover:bg-hover-paper">
                    <td className="px-3 py-2 tabular-nums text-muted">{e.seq}</td>
                    <td className="px-3 py-2">
                      <EventTypeChip type={e.type as AgentRunEventType} />
                    </td>
                    <td className="px-3 py-2">
                      <div className="text-ink">{e.summary}</div>
                      <PayloadView payload={e.payload} />
                      {e.type === "gate" && (
                        <Link
                          href="/dashboard/approvals"
                          className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-ink underline hover:text-focus"
                        >
                          <ShieldCheck className="size-3" />
                          Open in approval inbox
                        </Link>
                      )}
                    </td>
                    <td className="px-3 py-2 tabular-nums text-muted">{fmtTime(e.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* Approvals: pending items for the run's mission link out to the
          slice-3 approval flow. This page never decides approvals. */}
      <Section
        title="Approvals"
        description={
          run.missionId
            ? "Pending items for this run's mission — decided in the approval inbox"
            : "This run is not linked to a mission"
        }
        actions={
          <Link href="/dashboard/approvals" className={btnSecondary}>
            <ShieldCheck className="size-3.5" />
            Approval inbox
          </Link>
        }
        bodyClassName="p-0"
      >
        {pendingApprovals.length === 0 ? (
          <p className="p-4 text-sm text-muted">
            {gateEvents.length > 0
              ? `${gateEvents.length} gate event${gateEvents.length === 1 ? "" : "s"} in the timeline; nothing pending right now.`
              : "No pending approvals for this run."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs font-semibold text-muted">
                  <th className="px-3 py-2 font-semibold">Action</th>
                  <th className="w-20 px-3 py-2 font-semibold">Tier</th>
                  <th className="w-40 px-3 py-2 font-semibold">Requested</th>
                </tr>
              </thead>
              <tbody>
                {pendingApprovals.map((a) => (
                  <tr key={a.id} className="border-b border-line last:border-b-0 hover:bg-hover-paper">
                    <td className="px-3 py-2 text-ink">{a.action}</td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center rounded-full bg-paper px-2 py-0.5 text-xs font-semibold text-muted shadow-control">
                        Tier {a.tier}
                      </span>
                    </td>
                    <td className="px-3 py-2 tabular-nums text-muted">{fmtTime(a.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="flex items-center gap-1.5 border-t border-line px-4 py-2.5 text-xs text-muted">
          <Globe className="size-3.5" />
          Approve, deny, and edit happen in the approval inbox — this page is read-only.
        </p>
      </Section>
    </div>
  );
}
