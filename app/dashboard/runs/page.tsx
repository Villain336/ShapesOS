// ShapesOS — agent runs index (Phase 3 J).
//
// /dashboard/runs — every recorded agent run in the workspace, newest first,
// each linking to the run viewer (/dashboard/runs/[runId]). Reads go through
// the tenant scope (agent_runs is FORCE RLS, fail-closed) plus an explicit
// workspaceId filter.

import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowUpRight, Film, Workflow } from "lucide-react";
import type { AgentRunStatus as PrismaRunStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { getMembership } from "@/lib/authz";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import type { AgentRunStatus } from "@/lib/agents/runs/types";
import { RunStatusBadge } from "@/components/runs/RunStatusBadge";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Agent runs — ShapesOS",
  description: "Every agent run in this workspace — status, who started it, duration and recording.",
};

const STATUS_FILTERS: Array<{ value: AgentRunStatus | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "queued", label: "Queued" },
  { value: "failed", label: "Failed" },
  { value: "succeeded", label: "Succeeded" },
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

function fmtTime(d: Date): string {
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function kindLabel(kind: string): string {
  const t = kind.replace(/_/g, " ");
  return t[0]!.toUpperCase() + t.slice(1);
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

  const runs = await withWorkspaceScope(workspace.id, (tx) =>
    tx.agentRun.findMany({
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
    }),
  );

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
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <div>
        <h1 className="aos-heading">Agent runs</h1>
        <p className="mt-0.5 text-sm text-muted">
          {workspace.name} — every recorded agent run. Open one to replay its timeline, video and trace.
        </p>
      </div>

      <nav aria-label="Filter runs by status" className="flex flex-wrap items-center gap-2">
        {STATUS_FILTERS.map((f) => {
          const active = (f.value === "all" && !status) || f.value === status;
          return (
            <Link
              key={f.value}
              href={f.value === "all" ? "/dashboard/runs" : `/dashboard/runs?status=${f.value}`}
              aria-current={active ? "page" : undefined}
              className={`inline-flex h-chip items-center rounded-full px-3 text-sm font-semibold aos-press ${
                active ? "bg-ink text-white" : "bg-paper text-ink shadow-control hover:shadow-outline"
              }`}
            >
              {f.label}
            </Link>
          );
        })}
      </nav>

      {runs.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg bg-paper px-6 py-12 text-center shadow-hairline">
          <Workflow size={28} className="text-subtle" />
          <div className="text-sm font-semibold text-ink">{status ? "No runs with this status" : "No agent runs yet"}</div>
          <div className="max-w-[360px] text-sm text-muted">
            Runs appear here when a mission, playbook or browser agent works. Start one from{" "}
            <Link href="/dashboard/missions" className="font-semibold text-ink underline">
              Missions
            </Link>
            .
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg bg-paper shadow-hairline">
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs font-semibold text-muted">
                <th className="px-3 py-2 font-semibold">Status</th>
                <th className="px-3 py-2 font-semibold">Run</th>
                <th className="px-3 py-2 font-semibold">Started by</th>
                <th className="px-3 py-2 font-semibold">Linked to</th>
                <th className="px-3 py-2 font-semibold">Started</th>
                <th className="px-3 py-2 font-semibold">Duration</th>
                <th className="px-3 py-2 font-semibold">Events</th>
                <th className="px-3 py-2 text-right font-semibold">
                  <span className="sr-only">Open</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const ended = r.endedAt?.getTime() ?? (r.status === "running" || r.status === "queued" ? now : null);
                return (
                  <tr key={r.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                    <td className="px-3 py-2.5 align-top">
                      <RunStatusBadge status={r.status as AgentRunStatus} />
                    </td>
                    <td className="px-3 py-2.5 align-top">
                      <Link href={`/dashboard/runs/${r.id}`} className="font-semibold text-ink hover:underline">
                        {kindLabel(r.kind)} run
                      </Link>
                      <div className="font-mono text-xs text-subtle">{r.id.slice(0, 12)}…</div>
                    </td>
                    <td className="max-w-[180px] truncate px-3 py-2.5 align-top text-ink">{starter(r.startedBy)}</td>
                    <td className="px-3 py-2.5 align-top">
                      {r.missionId ? (
                        <Link href={`/dashboard/missions/${r.missionId}`} className="text-ink underline">
                          Mission
                        </Link>
                      ) : r.threadId ? (
                        <span className="text-muted">Chat thread</span>
                      ) : (
                        <span className="text-subtle">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 align-top text-muted">{fmtTime(r.createdAt)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 align-top text-muted">
                      {ended === null ? "—" : fmtDuration(ended - r.createdAt.getTime())}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 align-top text-muted">
                      <span className="inline-flex items-center gap-1.5">
                        {r._count.events}
                        {r.recording?.videoPath && <Film size={13} aria-label="Has a recording" />}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right align-top">
                      <Link
                        href={`/dashboard/runs/${r.id}`}
                        className="inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper"
                      >
                        Open
                        <ArrowUpRight size={14} />
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {runs.length === PAGE_SIZE && (
        <p className="text-xs text-muted">Showing the latest {PAGE_SIZE} runs. Filter by status to narrow the list.</p>
      )}
    </div>
  );
}
