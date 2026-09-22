// Marketr — skill run detail page (Phase B, W2).
// Timeline, subagent breakdown, cost, firing event payload, outputs.
// Viewer+ reads; approve/reject for skills.install holders.

import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { accessibleWorkspaceWhere, hasPermission } from "@/lib/authz";
import { getOutputStoreAsync } from "@/lib/scheduler/outputStore";
import { cardCls } from "@/components/settings/ui";
import RunApprovalActions from "@/components/scheduler/RunApprovalActions";

export const dynamic = "force-dynamic";

const STATUS_CLS: Record<string, string> = {
  succeeded: "border-emerald-200 bg-emerald-50 text-emerald-800",
  failed: "border-red-200 bg-red-50 text-red-700",
  running: "border-sky-200 bg-sky-50 text-sky-700",
  awaiting_approval: "border-amber-200 bg-amber-50 text-amber-800",
  rejected: "border-zinc-200 bg-zinc-100 text-zinc-600",
  cancelled: "border-zinc-200 bg-zinc-100 text-zinc-600",
};

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ id: string; runId: string }>;
}) {
  const user = await requireUser();
  if (!user) return null;
  const { id, runId } = await params;
  const project = await prisma.project.findFirst({
    where: { id, workspace: accessibleWorkspaceWhere(user.id) },
    select: { id: true, workspaceId: true },
  });
  if (!project) notFound();

  const run = await prisma.skillRun.findFirst({
    where: { id: runId, workspaceId: project.workspaceId },
    include: {
      skill: { select: { id: true, name: true, slug: true } },
      schedule: { select: { id: true, triggerType: true, cronExpr: true, eventSource: true, approvalMode: true } },
      subagents: { orderBy: { startedAt: "asc" } },
    },
  });
  if (!run) notFound();
  if (run.projectId && run.projectId !== project.id) notFound();

  const canApprove = await hasPermission(user.id, project.workspaceId, "skills.install");

  let report: string | null = null;
  if (run.outputPath) {
    try {
      report = await (await getOutputStoreAsync()).readReport(project.workspaceId, run.outputPath);
    } catch {
      report = null;
    }
  }

  const durationMs =
    run.finishedAt && run.startedAt ? run.finishedAt.getTime() - run.startedAt.getTime() : null;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          <Link href={`/dashboard/projects/${project.id}/automations`} className="hover:text-accent">Automations</Link>
          {" / "}
          <Link href={`/dashboard/projects/${project.id}/automations/schedules`} className="hover:text-accent">Schedules</Link>
          {" / Run"}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="font-display text-3xl">{run.skill.name}</h1>
          <span className={`rounded-full border px-2 py-0.5 text-xs ${STATUS_CLS[run.status] ?? "border-zinc-200 bg-zinc-100 text-zinc-600"}`}>
            {run.status.replace(/_/g, " ")}
          </span>
        </div>
        <p className="mt-2 text-sm text-zinc-600">
          Trigger: {run.trigger}
          {run.schedule ? ` · schedule ${run.schedule.triggerType}${run.schedule.cronExpr ? ` ${run.schedule.cronExpr}` : ""}${run.schedule.eventSource ? ` ${run.schedule.eventSource}` : ""}` : ""}
          {run.wasMissed ? " · fired from a missed window" : ""}
        </p>
      </div>

      {run.status === "awaiting_approval" && canApprove && (
        <section className={`${cardCls} border-amber-200 bg-amber-50/40`}>
          <h2 className="text-sm font-semibold text-zinc-900">Approval needed</h2>
          <p className="mt-1 text-xs text-zinc-600">This supervised run has executed nothing. Approving runs the skill; rejecting discards it.</p>
          <div className="mt-3">
            <RunApprovalActions runId={run.id} workspaceId={project.workspaceId} />
          </div>
        </section>
      )}

      <section className={cardCls}>
        <h2 className="text-sm font-semibold text-zinc-900">Timeline</h2>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-zinc-500">Started</dt>
            <dd className="mt-0.5">{new Date(run.startedAt).toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500">Finished</dt>
            <dd className="mt-0.5">{run.finishedAt ? new Date(run.finishedAt).toLocaleString() : "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500">Duration</dt>
            <dd className="mt-0.5">{durationMs !== null ? `${(durationMs / 1000).toFixed(1)}s` : "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500">Credits used</dt>
            <dd className="mt-0.5 font-medium">{run.creditsUsed}</dd>
          </div>
        </dl>
        {run.error && (
          <p className="mt-3 rounded-md border border-red-200 bg-red-50/60 px-3 py-2 text-sm text-red-700">{run.error}</p>
        )}
        {run.eventPayload && (
          <div className="mt-4">
            <h3 className="text-xs font-medium text-zinc-600">Firing event payload</h3>
            <pre className="mt-1 overflow-x-auto rounded-lg border border-zinc-200 bg-zinc-50 p-3 font-mono text-xs text-zinc-800">
              {JSON.stringify(run.eventPayload, null, 2)}
            </pre>
          </div>
        )}
      </section>

      <section className={cardCls}>
        <h2 className="text-sm font-semibold text-zinc-900">
          Subagents ({run.subagents.length})
        </h2>
        {run.subagents.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500">No subagents in this run.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-3">
            {run.subagents.map((s) => (
              <li key={s.id} className="rounded-lg border border-zinc-200 bg-white p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium text-zinc-900">{s.taskLabel}</p>
                  <p className="text-xs text-zinc-500">
                    {s.status} · {s.creditsUsed} credits
                    {s.finishedAt && s.startedAt ? ` · ${((s.finishedAt.getTime() - s.startedAt.getTime()) / 1000).toFixed(1)}s` : ""}
                  </p>
                </div>
                {s.result && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-zinc-500 hover:text-accent">View result</summary>
                    <pre className="mt-1 whitespace-pre-wrap rounded-md bg-zinc-50 p-2 font-mono text-xs text-zinc-800">{s.result}</pre>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={cardCls}>
        <h2 className="text-sm font-semibold text-zinc-900">Output</h2>
        {run.outputPath ? (
          <div className="mt-2">
            <p className="font-mono text-xs text-zinc-500">{run.outputPath}</p>
            {report ? (
              <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border border-zinc-200 bg-white p-4 text-sm text-zinc-800">
                {report}
              </pre>
            ) : (
              <p className="mt-2 text-sm text-zinc-500">Report file not readable yet (filesystem service may not be migrated).</p>
            )}
          </div>
        ) : (
          <p className="mt-2 text-sm text-zinc-500">No output written for this run.</p>
        )}
      </section>
    </div>
  );
}
