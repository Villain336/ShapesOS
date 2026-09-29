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
import { Stat } from "@/components/vault/Stat";
import { Card, CardBody, CardHeader } from "@/components/vault/Card";
import { ValuePill } from "@/components/vault/atoms/ValuePill";
import { buttonVariants } from "@/components/vault/atoms/button-variants";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Agent run — Marketr",
  description: "Watch the agent work: event timeline, recording, and trace.",
};

const EVENT_META: Record<AgentRunEventType, { icon: LucideIcon; tone: "neutral" | "accent" | "orange" }> = {
  agui: { icon: Zap, tone: "accent" },
  gate: { icon: ShieldCheck, tone: "orange" },
  browser: { icon: Monitor, tone: "neutral" },
  note: { icon: StickyNote, tone: "neutral" },
};

const STATUS_TONE: Record<AgentRunStatus, "neutral" | "accent" | "green" | "orange" | "red"> = {
  queued: "neutral",
  running: "accent",
  succeeded: "green",
  failed: "red",
  cancelled: "orange",
};

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
            <details key={key} className="text-[12px] text-stone-500">
              <summary className="cursor-pointer hover:text-stone-700">{key} (detail)</summary>
              <pre className="mt-1 max-h-48 overflow-auto rounded border border-stone-200 bg-stone-50 p-2 text-[11.5px] text-stone-700">
                {JSON.stringify(value, null, 2)}
              </pre>
            </details>
          );
        }
        return (
          <div key={key} className="flex gap-1.5 text-[12px]">
            <span className="shrink-0 font-medium text-stone-500">{key}:</span>
            <span className="min-w-0 truncate text-stone-700">{String(value)}</span>
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
    <div className="flex flex-col gap-6">
      <Link
        href="/dashboard"
        className={cn(buttonVariants({ variant: "quiet", size: "xs" }), "self-start")}
      >
        <ArrowLeft className="size-3.5" />
        Dashboard
      </Link>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-stone-900">Agent run</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-stone-500">
            <ValuePill tone={STATUS_TONE[run.status]}>{run.status}</ValuePill>
            <ValuePill>{run.kind}</ValuePill>
            <span>started by {run.startedBy}</span>
            <span aria-hidden className="text-stone-300">·</span>
            <span>{fmtTime(run.createdAt)}</span>
            {run.endedAt && (
              <>
                <span aria-hidden className="text-stone-300">·</span>
                <span>ended {fmtTime(run.endedAt)}</span>
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {run.missionId && (
            <Link
              href={`/dashboard/missions/${run.missionId}`}
              className={buttonVariants({ variant: "secondary", size: "sm" })}
            >
              Mission
            </Link>
          )}
          {run.threadId && <ValuePill>thread {run.threadId}</ValuePill>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Timeline events" value={events.length} icon={<ListOrdered className="size-4" />} />
        <Stat label="Browser steps" value={recording?.stepCount ?? 0} icon={<Monitor className="size-4" />} />
        <Stat label="Duration" value={fmtDuration(durationMs)} icon={<Clock className="size-4" />} />
        <Stat label="Artifacts" value={fmtBytes(recording?.sizeBytes ?? 0)} icon={<Film className="size-4" />} />
      </div>

      {/* Recording: video + trace download. Bytes stream through the
          workspace-scoped API route; no filesystem paths reach the client. */}
      <Card>
        <CardHeader
          title="Recording"
          description="Playwright video and trace for this run"
          actions={
            traceUrl ? (
              <a href={traceUrl} className={buttonVariants({ variant: "accent", size: "sm" })}>
                <Download className="size-3.5" />
                Download trace.zip
              </a>
            ) : undefined
          }
        />
        <CardBody className="flex flex-col gap-3">
          {videoUrl ? (
            <video controls preload="metadata" src={videoUrl} className="aspect-video w-full rounded-lg bg-black" />
          ) : (
            <p className="flex items-center gap-2 text-[13px] text-stone-500">
              <Video className="size-4" />
              No video was recorded for this run.
            </p>
          )}
          <p className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-[12.5px] text-stone-500">
            Retention: videos are dropped 30 days after creation unless pinned; the trace is
            kept and summarized instead of deleted.
          </p>
        </CardBody>
      </Card>

      {/* Step strip: DOM-snapshot strip from browser timeline events.
          Full frame-by-frame DOM replay = download the trace above. */}
      {browserEvents.length > 0 && (
        <Card>
          <CardHeader
            title="Step strip"
            description="Browser steps in order — from timeline events"
          />
          <CardBody className="p-3">
            <ol className="flex gap-2 overflow-x-auto pb-1">
              {browserEvents.map((e) => (
                <li
                  key={e.id}
                  className="w-52 shrink-0 rounded-lg border border-stone-200 bg-white p-2.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">
                      step {e.seq}
                    </span>
                    <span className="text-[11px] tabular-nums text-stone-400">
                      +{fmtDuration(e.createdAt.getTime() - run.createdAt.getTime())}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-3 text-[12.5px] leading-snug text-stone-700">
                    {e.summary}
                  </p>
                </li>
              ))}
            </ol>
            <p className="mt-2 text-[12px] text-stone-500">
              For frame-by-frame DOM replay, download the trace and open it in the Playwright
              trace viewer.
            </p>
          </CardBody>
        </Card>
      )}

      {/* Timeline: dense table, seq-ordered, typed with readable payloads. */}
      <Card>
        <CardHeader title="Timeline" description={`${events.length} event${events.length === 1 ? "" : "s"}, in order`} />
        <CardBody className="p-0">
          {events.length === 0 ? (
            <p className="p-4 text-[13px] text-stone-500">No events yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-[13px]">
                <thead>
                  <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
                    <th className="w-14 px-3 py-2 font-medium">Seq</th>
                    <th className="w-28 px-3 py-2 font-medium">Type</th>
                    <th className="px-3 py-2 font-medium">Event</th>
                    <th className="w-40 px-3 py-2 font-medium">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((e) => {
                    const meta = EVENT_META[e.type as AgentRunEventType];
                    const Icon = meta?.icon ?? StickyNote;
                    return (
                      <tr key={e.id} className="border-b border-stone-100 last:border-b-0 hover:bg-[var(--brand-50)]/40">
                        <td className="px-3 py-2 tabular-nums text-stone-500">{e.seq}</td>
                        <td className="px-3 py-2">
                          <ValuePill tone={meta?.tone ?? "neutral"}>
                            <Icon className="mr-1 inline size-3" />
                            {e.type}
                          </ValuePill>
                        </td>
                        <td className="px-3 py-2">
                          <div className="text-stone-800">{e.summary}</div>
                          <PayloadView payload={e.payload} />
                          {e.type === "gate" && (
                            <Link
                              href="/dashboard/approvals"
                              className="mt-1 inline-flex items-center gap-1 text-[12px] font-medium text-[var(--brand-700)] hover:underline"
                            >
                              <ShieldCheck className="size-3" />
                              Open in approval inbox
                            </Link>
                          )}
                        </td>
                        <td className="px-3 py-2 tabular-nums text-stone-500">{fmtTime(e.createdAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      {/* Approvals: pending items for the run's mission link out to the
          slice-3 approval flow. This page never decides approvals. */}
      <Card>
        <CardHeader
          title="Approvals"
          description={
            run.missionId
              ? "Pending items for this run's mission — decided in the approval inbox"
              : "This run is not linked to a mission"
          }
          actions={
            <Link href="/dashboard/approvals" className={buttonVariants({ variant: "secondary", size: "sm" })}>
              <ShieldCheck className="size-3.5" />
              Approval inbox
            </Link>
          }
        />
        <CardBody className="p-0">
          {pendingApprovals.length === 0 ? (
            <p className="p-4 text-[13px] text-stone-500">
              {gateEvents.length > 0
                ? `${gateEvents.length} gate event${gateEvents.length === 1 ? "" : "s"} in the timeline; nothing pending right now.`
                : "No pending approvals for this run."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-left text-[13px]">
                <thead>
                  <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
                    <th className="px-3 py-2 font-medium">Action</th>
                    <th className="w-20 px-3 py-2 font-medium">Tier</th>
                    <th className="w-40 px-3 py-2 font-medium">Requested</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingApprovals.map((a) => (
                    <tr key={a.id} className="border-b border-stone-100 last:border-b-0 hover:bg-[var(--brand-50)]/40">
                      <td className="px-3 py-2 text-stone-800">{a.action}</td>
                      <td className="px-3 py-2">
                        <ValuePill tone="orange">tier {a.tier}</ValuePill>
                      </td>
                      <td className="px-3 py-2 tabular-nums text-stone-500">{fmtTime(a.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="flex items-center gap-1.5 border-t border-stone-100 px-4 py-2.5 text-[12px] text-stone-500">
            <Globe className="size-3.5" />
            Approve, deny, and edit happen in the approval inbox — this page is read-only.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
