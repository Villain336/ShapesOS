// Marketr — skill run detail page (Phase B, W2).
// Timeline, subagent breakdown, cost, firing event payload, outputs.
// Viewer+ reads; approve/reject for skills.install holders.

import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { accessibleWorkspaceWhere, hasPermission } from "@/lib/authz";
import { getOutputStoreAsync } from "@/lib/scheduler/outputStore";
import { cardCls } from "@/components/workspace/aos";
import RunApprovalActions from "@/components/scheduler/RunApprovalActions";

export const dynamic = "force-dynamic";

// Run states carry status color + shape (DESIGN.md); rejected/cancelled are plain.
const STATUS_CLS: Record<string, { cls: string; shape?: string }> = {
  succeeded: { cls: "bg-done text-white", shape: "aos-shape--done" },
  failed: { cls: "bg-failed text-white", shape: "aos-shape--failed" },
  running: { cls: "bg-running text-white", shape: "aos-shape--running aos-is-live" },
  awaiting_approval: { cls: "bg-needs text-ink", shape: "aos-shape--needs" },
  rejected: { cls: "bg-canvas text-muted" },
  cancelled: { cls: "bg-canvas text-muted" },
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
        <p className="text-xs font-semibold text-muted">
          <Link href={`/dashboard/projects/${project.id}/automations`} className="hover:text-focus hover:underline">Automations</Link>
          {" / "}
          <Link href={`/dashboard/projects/${project.id}/automations/schedules`} className="hover:text-focus hover:underline">Schedules</Link>
          {" / Run"}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="aos-heading">{run.skill.name}</h1>
          <span className={`inline-flex h-badge items-center gap-1.5 rounded-full px-2.5 text-sm font-semibold ${STATUS_CLS[run.status]?.cls ?? "bg-canvas text-muted"}`}>
            {STATUS_CLS[run.status]?.shape && (
              <span aria-hidden className={`aos-shape ${STATUS_CLS[run.status]?.shape}`} style={{ color: "inherit" }} />
            )}
            {run.status.replace(/_/g, " ")}
          </span>
        </div>
        <p className="mt-2 text-sm text-muted">
          Trigger: {run.trigger}
          {run.schedule ? ` · schedule ${run.schedule.triggerType}${run.schedule.cronExpr ? ` ${run.schedule.cronExpr}` : ""}${run.schedule.eventSource ? ` ${run.schedule.eventSource}` : ""}` : ""}
          {run.wasMissed ? " · fired from a missed window" : ""}
        </p>
      </div>

      {run.status === "awaiting_approval" && canApprove && (
        <section className="rounded-lg bg-needs-tint p-5 shadow-hairline">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <span aria-hidden className="aos-shape aos-shape--needs aos-shape--edged" />
            Approval needed
          </h2>
          <p className="mt-1 text-xs text-muted">This supervised run has executed nothing. Approving runs the skill; rejecting discards it.</p>
          <div className="mt-3">
            <RunApprovalActions runId={run.id} workspaceId={project.workspaceId} />
          </div>
        </section>
      )}

      <section className={cardCls}>
        <h2 className="text-sm font-semibold text-ink">Timeline</h2>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted">Started</dt>
            <dd className="mt-0.5">{new Date(run.startedAt).toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Finished</dt>
            <dd className="mt-0.5">{run.finishedAt ? new Date(run.finishedAt).toLocaleString() : "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Duration</dt>
            <dd className="mt-0.5">{durationMs !== null ? `${(durationMs / 1000).toFixed(1)}s` : "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Credits used</dt>
            <dd className="mt-0.5 font-medium">{run.creditsUsed}</dd>
          </div>
        </dl>
        {run.error && (
          <p className="mt-3 rounded-md bg-failed-tint px-3 py-2 text-sm text-failed-text">{run.error}</p>
        )}
        {run.eventPayload && (
          <div className="mt-4">
            <h3 className="text-xs font-medium text-muted">Firing event payload</h3>
            <pre className="mt-1 overflow-x-auto rounded-lg border border-line bg-canvas p-3 font-mono text-xs text-ink">
              {JSON.stringify(run.eventPayload, null, 2)}
            </pre>
          </div>
        )}
      </section>

      <section className={cardCls}>
        <h2 className="text-sm font-semibold text-ink">
          Subagents ({run.subagents.length})
        </h2>
        {run.subagents.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No subagents in this run.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-3">
            {run.subagents.map((s) => (
              <li key={s.id} className="rounded-lg border border-line bg-paper p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium text-ink">{s.taskLabel}</p>
                  <p className="text-xs text-muted">
                    {s.status} · {s.creditsUsed} credits
                    {s.finishedAt && s.startedAt ? ` · ${((s.finishedAt.getTime() - s.startedAt.getTime()) / 1000).toFixed(1)}s` : ""}
                  </p>
                </div>
                {s.result && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-muted hover:text-ink">View result</summary>
                    <pre className="mt-1 whitespace-pre-wrap rounded-md bg-canvas p-2 font-mono text-xs text-ink">{s.result}</pre>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={cardCls}>
        <h2 className="text-sm font-semibold text-ink">Output</h2>
        {run.outputPath ? (
          <div className="mt-2">
            <p className="font-mono text-xs text-muted">{run.outputPath}</p>
            {report ? (
              <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-paper p-4 text-sm text-ink">
                {report}
              </pre>
            ) : (
              <p className="mt-2 text-sm text-muted">Report file not readable yet (filesystem service may not be migrated).</p>
            )}
          </div>
        ) : (
          <p className="mt-2 text-sm text-muted">No output written for this run.</p>
        )}
      </section>
    </div>
  );
}
