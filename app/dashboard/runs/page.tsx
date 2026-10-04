// ShapesOS — agent runs index (Phase 3 J; Agentic OS 4d).
//
// /dashboard/runs — every recorded agent run in the workspace, newest first,
// as a dense list: the run's state (status color + shape + label), the agent
// that ran it (black monogram tile; mission runs are the lead's), what it
// was for (its mission), who started it, when and how long. Each row opens
// the run viewer (/dashboard/runs/[runId]). Reads go through the tenant
// scope (agent_runs, missions and mission_approvals are FORCE RLS,
// fail-closed) plus an explicit workspaceId filter.

import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronRight, Film, Workflow } from "lucide-react";
import type { AgentRunStatus as PrismaRunStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { getMembership } from "@/lib/authz";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import type { AgentRunStatus } from "@/lib/agents/runs/types";
import { AgentAvatar, FilterPill, StatusBadge } from "@/components/aos";
import { missionDisplayName } from "@/lib/aos/missions";
import { clockTime, runAgentName, runStatus, runTitle } from "@/lib/aos/runs";
import type { AosStatus } from "@/lib/aos/status";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Agent runs — ShapesOS",
  description: "Every agent run in this workspace — status, who started it, duration and recording.",
};

const STATUS_FILTERS: Array<{ value: AgentRunStatus | "all"; label: string; shape?: AosStatus }> = [
  { value: "all", label: "All" },
  { value: "running", label: "Running", shape: "running" },
  { value: "queued", label: "Queued", shape: "queued" },
  { value: "failed", label: "Failed", shape: "failed" },
  { value: "succeeded", label: "Done", shape: "done" },
  { value: "cancelled", label: "Cancelled" },
];

const PAGE_SIZE = 100;

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function fmtDay(d: Date): string {
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return `Today ${clockTime(d)}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${clockTime(d)}`;
}

function NeutralBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex h-6 shrink-0 items-center rounded-full bg-paper px-2.5 text-xs font-semibold text-muted shadow-control">
      {label}
    </span>
  );
}

export default async function RunsIndexPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await getMembership(user.id, workspace.id))) redirect("/dashboard");

  const sp = await searchParams;
  const raw = Array.isArray(sp.status) ? sp.status[0] : sp.status;
  const status = STATUS_FILTERS.some((f) => f.value === raw && raw !== "all") ? (raw as AgentRunStatus) : null;

  const { runs, counts, missions, pending } = await withWorkspaceScope(workspace.id, async (tx) => {
    const runs = await tx.agentRun.findMany({
      where: { workspaceId: workspace.id, ...(status ? { status: status as PrismaRunStatus } : {}) },
      orderBy: { createdAt: "desc" },
      take: PAGE_SIZE,
      select: {
        id: true,
        kind: true,
        status: true,
        startedBy: true,
        missionId: true,
        threadId: true,
        createdAt: true,
        endedAt: true,
        recording: { select: { stepCount: true, videoPath: true } },
        _count: { select: { events: true } },
      },
    });
    const missionIds = [...new Set(runs.map((r) => r.missionId).filter((v): v is string => !!v))];
    const [counts, missions, pending] = await Promise.all([
      tx.agentRun.groupBy({ by: ["status"], where: { workspaceId: workspace.id }, _count: { _all: true } }),
      missionIds.length
        ? tx.mission.findMany({ where: { workspaceId: workspace.id, id: { in: missionIds } }, select: { id: true, goal: true, template: true } })
        : Promise.resolve([]),
      missionIds.length
        ? tx.missionApproval.groupBy({
            by: ["missionId"],
            where: { workspaceId: workspace.id, missionId: { in: missionIds }, status: "pending" },
            _count: { _all: true },
          })
        : Promise.resolve([]),
    ]);
    return { runs, counts, missions, pending };
  });

  const countBy = new Map(counts.map((c) => [c.status as string, c._count._all]));
  const total = counts.reduce((n, c) => n + c._count._all, 0);
  const missionName = new Map(missions.map((m) => [m.id, missionDisplayName(m.goal, m.template)]));
  const pendingBy = new Map(pending.map((p) => [p.missionId, p._count._all]));

  // Who started each run: member name/email; agents and services stay as-is.
  const starterIds = [...new Set(runs.map((r) => r.startedBy).filter((s) => s && !s.includes(":")))];
  const members = starterIds.length
    ? await prisma.workspaceMember.findMany({
        where: { workspaceId: workspace.id, userId: { in: starterIds } },
        select: { userId: true, name: true, email: true },
      })
    : [];
  const nameOf = new Map(members.map((m) => [m.userId, m.name || m.email || "Workspace member"]));
  const starter = (s: string) => nameOf.get(s) ?? (s.startsWith("agent") ? "Agent" : s.includes(":") ? s : "Workspace member");

  const now = Date.now();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="aos-heading">Runs</h1>
        <p className="mt-1 text-md text-muted">
          Every agent run in {workspace.name}. Open one to follow its steps, tool calls and recording.
        </p>
      </div>

      <nav aria-label="Filter runs by status" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {STATUS_FILTERS.map((f) => {
          const active = (f.value === "all" && !status) || f.value === status;
          return (
            <FilterPill
              key={f.value}
              href={f.value === "all" ? "/dashboard/runs" : `/dashboard/runs?status=${f.value}`}
              selected={active}
              status={f.shape}
              count={f.value === "all" ? total : (countBy.get(f.value) ?? 0)}
            >
              {f.label}
            </FilterPill>
          );
        })}
      </nav>

      {runs.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg bg-paper px-6 py-14 text-center shadow-hairline">
          <Workflow size={28} className="text-subtle" aria-hidden />
          <h2 className="aos-subheading">{status ? "No runs with this status" : "No agent runs yet"}</h2>
          <p className="max-w-[44ch] text-md text-muted">
            Runs appear here when a mission, playbook or browser agent works. Start one from{" "}
            <Link href="/dashboard/missions" className="font-semibold text-ink underline underline-offset-4">
              Missions
            </Link>
            .
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg bg-paper shadow-hairline">
          {/* Column labels (desktop) */}
          <div
            aria-hidden
            className="hidden grid-cols-[132px_minmax(0,1fr)_minmax(0,180px)_120px_88px_64px_20px] items-center gap-4 border-b border-line px-5 py-2.5 text-xs font-semibold text-muted lg:grid"
          >
            <span>Status</span>
            <span>Run</span>
            <span>Started by</span>
            <span>Started</span>
            <span>Duration</span>
            <span>Events</span>
            <span />
          </div>
          <ul>
            {runs.map((r) => {
              const pendingCount = r.missionId ? (pendingBy.get(r.missionId) ?? 0) : 0;
              const aos = runStatus(r.status, pendingCount);
              const mName = r.missionId ? (missionName.get(r.missionId) ?? null) : null;
              const agent = runAgentName(r.kind);
              const ended = r.endedAt?.getTime() ?? (r.status === "running" || r.status === "queued" ? now : null);
              const duration = ended === null ? "—" : fmtDuration(ended - r.createdAt.getTime());
              return (
                <li key={r.id} className="relative border-b border-line last:border-0">
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-3.5 transition-[background-color] duration-150 hover:bg-hover-paper sm:px-5 lg:grid-cols-[132px_minmax(0,1fr)_minmax(0,180px)_120px_88px_64px_20px]">
                    <div className="order-2 justify-self-end lg:order-none lg:justify-self-start">
                      {aos ? (
                        <StatusBadge status={aos} size="sm" label={aos === "done" ? "Done" : undefined} />
                      ) : (
                        <NeutralBadge label="Cancelled" />
                      )}
                    </div>
                    <div className="order-1 flex min-w-0 items-center gap-3 lg:order-none">
                      <AgentAvatar name={agent} size="md" />
                      <div className="min-w-0">
                        <Link
                          href={`/dashboard/runs/${r.id}`}
                          className="block truncate text-base leading-5 font-semibold text-ink after:absolute after:inset-0 after:content-['']"
                        >
                          {runTitle(r.kind, mName)}
                        </Link>
                        <p className="truncate text-sm text-muted">
                          {agent}
                          {r.missionId ? (
                            <>
                              {" · "}
                              <Link
                                href={`/dashboard/missions/${r.missionId}`}
                                className="relative z-10 font-semibold text-ink underline-offset-4 hover:underline"
                              >
                                Mission
                              </Link>
                            </>
                          ) : r.threadId ? (
                            " · Chat thread"
                          ) : null}
                          <span className="aos-mono ml-1.5 text-xs text-subtle">{r.id.slice(-8)}</span>
                        </p>
                      </div>
                    </div>
                    <span className="order-3 col-span-2 text-sm text-muted lg:order-none lg:col-span-1 lg:truncate lg:text-md lg:text-ink">
                      <span className="lg:hidden">Started by </span>
                      {starter(r.startedBy)}
                      <span className="lg:hidden">
                        {" · "}
                        {fmtDay(r.createdAt)} · {duration} · {r._count.events} events
                      </span>
                    </span>
                    <span className="hidden text-md text-muted tabular-nums lg:block">{fmtDay(r.createdAt)}</span>
                    <span className="hidden text-md text-muted tabular-nums lg:block">{duration}</span>
                    <span className="hidden items-center gap-1.5 text-md text-muted tabular-nums lg:inline-flex">
                      {r._count.events}
                      {r.recording?.videoPath ? <Film size={13} aria-label="Has a recording" /> : null}
                    </span>
                    <ChevronRight size={16} className="hidden text-subtle lg:block" aria-hidden />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {runs.length === PAGE_SIZE ? (
        <p className="text-sm text-muted">Showing the latest {PAGE_SIZE} runs. Filter by status to narrow the list.</p>
      ) : null}
    </div>
  );
}
