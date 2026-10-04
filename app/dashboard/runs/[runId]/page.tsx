// ShapesOS — run viewer (Phase 16 slice 6; Agentic OS 4d).
//
// /dashboard/runs/[runId] — the viewable-agent-run surface (spec §5), drawn
// as the kit's run timeline (agent-blocks.png): the run's title, who
// started it and when, its state, then each recorded step with its state
// shape, tool calls in JetBrains Mono, progress on the live step and the
// steps still to come (asks-first chips where a human decides). Beside it:
// what is waiting on you, the run's numbers, the recording and trace.
// All data loads through the slice-5 service (workspace-scoped, RLS
// fail-closed): a run from another workspace reads as null → notFound().
// Artifacts stream through the scoped API route — the page only ever
// builds route URLs, never filesystem paths. Approvals are decided in
// /dashboard/approvals; this page links out.

import Link from "next/link";
import { ArrowLeft, Download, Video } from "lucide-react";
import { notFound } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { getMembership, roleAtLeast } from "@/lib/authz";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { getAgentRun, listAgentRunEvents } from "@/lib/agents/runs/service";
import { prisma } from "@/lib/prisma";
import { Banner, aosButton } from "@/components/aos";
import { missionDisplayName } from "@/lib/aos/missions";
import { needsReconnect } from "@/lib/aos/home";
import { clockTime, runAgentName, runTimeline, runTitle, upcomingPlanSteps, type PlanStepInput } from "@/lib/aos/runs";
import { humanize } from "@/lib/approvals/format";
import { LiveWatch } from "./LiveWatch";
import { RunTimelinePanel } from "./RunTimelinePanel";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Agent run — ShapesOS",
  description: "Watch the agent work: steps, tool calls, recording, and trace.",
};

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
    <section className="overflow-hidden rounded-lg bg-paper shadow-hairline">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <h2 className="aos-subheading">{title}</h2>
          {description ? <p className="mt-0.5 text-sm text-muted">{description}</p> : null}
        </div>
        {actions}
      </div>
      <div className={bodyClassName ?? "p-5"}>{children}</div>
    </section>
  );
}

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
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function planSteps(snapshot: unknown): PlanStepInput[] {
  const steps = (snapshot as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps)) return [];
  return steps
    .map((s) => s as Record<string, unknown>)
    .filter((s) => typeof s.key === "string" && typeof s.title === "string")
    .map((s) => ({
      key: s.key as string,
      title: s.title as string,
      kind: typeof s.kind === "string" ? s.kind : undefined,
      executor: typeof s.executor === "string" ? s.executor : undefined,
      tier: typeof s.tier === "number" ? s.tier : undefined,
    }));
}

export default async function RunViewerPage({ params }: { params: Promise<{ runId: string }> }) {
  const user = await requireUser();
  if (!user) return null; // layout already redirects
  const { runId } = await params;
  const workspace = await getOrCreateWorkspace(user.id, user.email);

  const run = await getAgentRun(workspace.id, runId);
  if (!run) notFound();

  const [events, membership] = await Promise.all([listAgentRunEvents(workspace.id, runId), getMembership(user.id, workspace.id)]);

  // The run's mission: its name, state, plan (steps still to come) and the
  // approvals waiting on a person. Read-only here; decisions happen in the inbox.
  const mission = run.missionId
    ? await withWorkspaceScope(workspace.id, async (tx) => {
        const m = await tx.mission.findFirst({
          where: { id: run.missionId!, workspaceId: workspace.id },
          select: { id: true, goal: true, template: true, status: true, planSnapshot: true },
        });
        if (!m) return null;
        const [delegations, approvals] = await Promise.all([
          tx.missionEvent.count({ where: { missionId: m.id, workspaceId: workspace.id, step: { startsWith: "route." } } }),
          tx.missionApproval.findMany({
            where: { missionId: m.id, workspaceId: workspace.id, status: "pending" },
            orderBy: { createdAt: "desc" },
            take: 25,
            select: { id: true, action: true, tier: true, createdAt: true },
          }),
        ]);
        return { ...m, name: missionDisplayName(m.goal, m.template), delegations, approvals };
      })
    : null;
  const pendingApprovals = mission?.approvals ?? [];

  // Who started it: mission runs are the lead's; otherwise the member, else the run's agent.
  let starter = runAgentName(run.kind);
  if (run.kind !== "mission" && run.startedBy && !run.startedBy.includes(":")) {
    const member = await prisma.workspaceMember.findFirst({
      where: { workspaceId: workspace.id, userId: run.startedBy },
      select: { name: true, email: true },
    });
    if (member) starter = member.name || member.email || starter;
  }

  const timeline = runTimeline({
    status: run.status,
    events: events.map((e) => ({
      id: e.id,
      seq: e.seq,
      type: e.type,
      summary: e.summary,
      payload: e.payload,
      createdAt: e.createdAt.toISOString(),
    })),
    upcoming: mission ? upcomingPlanSteps(planSteps(mission.planSnapshot), mission.delegations, 3) : [],
    pendingApprovals: pendingApprovals.length,
  });

  const canControl = roleAtLeast(membership?.role, "editor");
  const live = run.status === "running" || run.status === "queued";
  const control =
    mission && canControl && live && (mission.status === "active" || mission.status === "paused")
      ? { missionId: mission.id, can: mission.status === "paused" ? ("resume" as const) : ("pause" as const) }
      : null;

  const recording = run.recording;
  const videoUrl = recording?.videoPath ? `/api/agent-runs/${run.id}/recording/video` : null;
  const traceUrl = recording?.tracePath ? `/api/agent-runs/${run.id}/recording/trace` : null;
  const endedAt = run.endedAt ?? new Date();
  const durationMs = endedAt.getTime() - run.createdAt.getTime();
  const browserEvents = events.filter((e) => e.type === "browser");
  const gateEvents = events.filter((e) => e.type === "gate");
  // What stopped a failed run: the last step's error, else its summary.
  const lastEvent = events[events.length - 1];
  const lastError = (lastEvent?.payload as { error?: unknown } | null)?.error;
  const failure = typeof lastError === "string" && lastError.trim() ? lastError.trim() : (lastEvent?.summary ?? null);

  const facts: Array<[string, string]> = [
    ["Started", fmtTime(run.createdAt)],
    ["Ended", run.endedAt ? fmtTime(run.endedAt) : "Still going"],
    ["Duration", fmtDuration(durationMs)],
    ["Steps recorded", String(events.length)],
    ["Browser steps", String(recording?.stepCount ?? 0)],
    ["Artifacts", fmtBytes(recording?.sizeBytes ?? 0)],
  ];

  return (
    <div className="flex flex-col gap-6">
      <Link href="/dashboard/runs" className={aosButton({ variant: "quiet", size: "sm", className: "-ml-3 self-start" })}>
        <ArrowLeft className="size-4" aria-hidden />
        All runs
      </Link>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <RunTimelinePanel
            title={runTitle(run.kind, mission?.name)}
            subtitle={`${starter} started this run at ${clockTime(run.createdAt)}${mission && run.kind !== "mission" ? ` · ${mission.name}` : ""}`}
            status={timeline.status}
            neutral={timeline.neutral}
            steps={timeline.steps}
            completed={timeline.completed}
            control={control}
          />

          {/* Slice 7: live watch — mounted ONLY while the run is running.
              Finished runs show the recorded video instead. */}
          {run.status === "running" ? <LiveWatch runId={run.id} /> : null}
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          {run.status === "failed" && failure ? (
            <Banner
              status="failed"
              title={`${runTitle(run.kind, mission?.name)} stopped`}
              description={needsReconnect(failure) ? `${failure.replace(/[.\s]+$/, "")}. Reconnect to resume.` : failure}
              action={needsReconnect(failure) ? { label: "Reconnect", href: "/dashboard/settings/connectors" } : null}
            />
          ) : null}
          {pendingApprovals.length > 0 ? (
            <div className="flex flex-col gap-2.5">
              <Banner
                status="needs"
                title={`${pendingApprovals.length} ${pendingApprovals.length === 1 ? "approval is" : "approvals are"} waiting on you`}
                description={`${mission?.name ?? "This mission"} paused for your approval. Decide in the inbox.`}
                action={{ label: "Review", href: "/dashboard/approvals?source=mission" }}
              />
              <ul className="divide-y divide-line rounded-lg bg-paper shadow-hairline">
                {pendingApprovals.map((a) => (
                  <li key={a.id} className="flex min-h-11 items-center justify-between gap-3 px-4 py-2.5 text-md">
                    <span className="min-w-0 truncate font-semibold text-ink">{humanize(a.action)}</span>
                    <span className="shrink-0 text-sm text-muted">
                      Tier {a.tier} · {fmtTime(a.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <Section
            title="About this run"
            description={run.threadId ? "Started from a chat thread" : mission ? "Part of a mission" : undefined}
            actions={
              mission ? (
                <Link href={`/dashboard/missions/${mission.id}`} className={aosButton({ variant: "secondary", size: "sm" })}>
                  Open mission
                </Link>
              ) : undefined
            }
            bodyClassName="px-5 py-2"
          >
            <dl className="divide-y divide-line">
              {facts.map(([k, v]) => (
                <div key={k} className="flex items-center justify-between gap-3 py-2.5 text-md">
                  <dt className="text-muted">{k}</dt>
                  <dd className="font-semibold text-ink tabular-nums">{v}</dd>
                </div>
              ))}
              <div className="flex items-center justify-between gap-3 py-2.5 text-md">
                <dt className="text-muted">Run ID</dt>
                <dd className="aos-mono truncate text-sm text-ink">{run.id}</dd>
              </div>
              {run.threadId ? (
                <div className="flex items-center justify-between gap-3 py-2.5 text-md">
                  <dt className="text-muted">Thread</dt>
                  <dd className="aos-mono truncate text-sm text-ink">{run.threadId}</dd>
                </div>
              ) : null}
            </dl>
            {pendingApprovals.length === 0 ? (
              <p className="border-t border-line py-3 text-sm text-muted">
                {gateEvents.length > 0
                  ? `${gateEvents.length} approval ${gateEvents.length === 1 ? "step" : "steps"} in this run; nothing is waiting on you now.`
                  : run.missionId
                    ? "Nothing from this run is waiting on you."
                    : "This run is not part of a mission."}
              </p>
            ) : null}
          </Section>

          {/* Recording: video + trace download. Bytes stream through the
              workspace-scoped API route; no filesystem paths reach the client. */}
          <Section
            title="Recording"
            description="Browser video and trace for this run"
            actions={
              traceUrl ? (
                <a href={traceUrl} className={aosButton({ variant: "primary", size: "sm" })}>
                  <Download className="size-4" aria-hidden />
                  Download trace
                </a>
              ) : undefined
            }
          >
            <div className="flex flex-col gap-3">
              {videoUrl ? (
                <video controls preload="metadata" src={videoUrl} className="aspect-video w-full rounded-md bg-ink" />
              ) : (
                <p className="flex items-center gap-2 text-md text-muted">
                  <Video className="size-4" aria-hidden />
                  No video was recorded for this run.
                </p>
              )}
              <p className="text-sm text-muted">
                Videos are dropped 30 days after creation unless pinned; the trace is kept and summarized instead.
              </p>
            </div>
          </Section>
        </div>
      </div>

      {/* Step strip: browser steps in order. Full frame-by-frame DOM replay =
          download the trace above. */}
      {browserEvents.length > 0 ? (
        <Section title="Browser steps" description="What the browser did, in order" bodyClassName="p-4">
          <ol className="flex gap-3 overflow-x-auto pb-1">
            {browserEvents.map((e) => (
              <li key={e.id} className="w-56 shrink-0 rounded-md bg-canvas p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-muted">Step {e.seq}</span>
                  <span className="text-xs text-subtle tabular-nums">
                    +{fmtDuration(e.createdAt.getTime() - run.createdAt.getTime())}
                  </span>
                </div>
                <p className="mt-1 line-clamp-3 text-sm leading-snug text-ink">{e.summary}</p>
              </li>
            ))}
          </ol>
          <p className="mt-2 text-sm text-muted">For frame-by-frame replay, download the trace and open it in the Playwright trace viewer.</p>
        </Section>
      ) : null}
    </div>
  );
}
