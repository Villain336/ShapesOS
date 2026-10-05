// ShapesOS — Phase 9 (repos): the repositories agents work on.
//
// /dashboard/runs/repositories — next to Runs, because everything here is a
// run's output:
//   * Agent pull requests (agent_pull_requests): every branch an agent pushed
//     (shapes/<runId>) and its PR — the agent's current state (the status of
//     the run that last worked on it; color + shape, agent states only), the
//     PR's state and checks (neutral: they are GitHub's, not an agent state),
//     the last feedback, and whether a continuation is queued. Each row opens
//     the run that last worked on it.
//   * Repository profiles (repo_profiles): the stack and the commands
//     run_checks runs, detected on the first clone.
// Reads go through the tenant scope (both tables are FORCE RLS) plus an
// explicit workspaceId filter. Members only.

import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, ChevronRight, ExternalLink, FolderGit2, GitPullRequest } from "lucide-react";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { getMembership } from "@/lib/authz";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { listAgentPullRequests, type AgentPullRequestRow } from "@/lib/ship/pull-requests";
import { CHECK_ORDER } from "@/lib/sandbox/repo-profile";
import { NeutralBadge, StatusBadge, aosButton } from "@/components/aos";
import { clockTime, runStatus } from "@/lib/aos/runs";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Repositories — ShapesOS",
  description: "The repositories agents work on: their pull requests, review feedback and detected stacks.",
};

const PR_STATE_LABEL: Record<string, string> = {
  pushed: "Branch pushed",
  open: "Open",
  merged: "Merged",
  closed: "Closed",
};

const CHECKS_LABEL: Record<string, string> = {
  success: "Checks passing",
  failure: "Checks failing",
  pending: "Checks running",
  none: "No checks",
};

function fmtWhen(d: Date | null): string {
  if (!d) return "—";
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return `Today ${clockTime(d)}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${clockTime(d)}`;
}

function AgentState({ pr, status }: { pr: AgentPullRequestRow; status: string | null }) {
  if (pr.pendingSince) return <StatusBadge status="queued" size="sm" label="Feedback queued" />;
  const aos = status ? runStatus(status) : null;
  if (!aos) return <NeutralBadge label={status === "cancelled" ? "Cancelled" : "No run"} size="sm" />;
  return <StatusBadge status={aos} size="sm" label={aos === "done" ? "Done" : undefined} />;
}

export default async function RepositoriesPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await getMembership(user.id, workspace.id))) redirect("/dashboard");

  const prs = await listAgentPullRequests(workspace.id, 100);
  const runIds = [...new Set(prs.map((p) => p.lastContinuedRunId ?? p.runId))];
  const { profiles, runs } = await withWorkspaceScope(workspace.id, async (tx) => {
    const [profiles, runs] = await Promise.all([
      tx.repoProfile.findMany({
        where: { workspaceId: workspace.id },
        orderBy: { updatedAt: "desc" },
        take: 100,
        select: { id: true, repoFullName: true, language: true, packageManager: true, commands: true, updatedAt: true },
      }),
      runIds.length
        ? tx.agentRun.findMany({ where: { workspaceId: workspace.id, id: { in: runIds } }, select: { id: true, status: true } })
        : Promise.resolve([]),
    ]);
    return { profiles, runs };
  });
  const statusOf = new Map(runs.map((r) => [r.id, r.status as string]));

  return (
    <div className="flex flex-col gap-6">
      <Link href="/dashboard/runs" className={aosButton({ variant: "quiet", size: "sm", className: "-ml-3 self-start" })}>
        <ArrowLeft className="size-4" aria-hidden />
        All runs
      </Link>

      <div>
        <h1 className="aos-heading">Repositories</h1>
        <p className="mt-1 text-md text-muted">
          The pull requests agents opened in {workspace.name}, the review feedback they are working on, and how each repository is checked.
        </p>
      </div>

      <section aria-labelledby="agent-prs" className="flex flex-col gap-3">
        <h2 id="agent-prs" className="aos-subheading">
          Agent pull requests
        </h2>
        {prs.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-lg bg-paper px-6 py-12 text-center shadow-hairline">
            <GitPullRequest size={28} className="text-subtle" aria-hidden />
            <h3 className="text-base font-semibold text-ink">No agent pull requests yet</h3>
            <p className="max-w-[52ch] text-md text-muted">
              Ask the Operator to work on a GitHub repository in the chat. Its branch and pull request show up here, and review comments on
              GitHub send it back to work on the same branch.
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg bg-paper shadow-hairline">
            <div
              aria-hidden
              className="hidden grid-cols-[148px_minmax(0,1fr)_128px_128px_minmax(0,1.1fr)_20px] items-center gap-4 border-b border-line px-5 py-2.5 text-xs font-semibold text-muted lg:grid"
            >
              <span>Agent</span>
              <span>Pull request</span>
              <span>State</span>
              <span>Checks</span>
              <span>Last feedback</span>
              <span />
            </div>
            <ul>
              {prs.map((pr) => {
                const runId = pr.lastContinuedRunId ?? pr.runId;
                return (
                  <li key={pr.id} className="relative border-b border-line last:border-0">
                    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-3.5 transition-[background-color] duration-150 hover:bg-hover-paper sm:px-5 lg:grid-cols-[148px_minmax(0,1fr)_128px_128px_minmax(0,1.1fr)_20px]">
                      <div className="order-2 justify-self-end lg:order-none lg:justify-self-start">
                        <AgentState pr={pr} status={statusOf.get(runId) ?? null} />
                      </div>
                      <div className="order-1 min-w-0 lg:order-none">
                        <Link
                          href={`/dashboard/runs/${runId}`}
                          className="block truncate text-base leading-5 font-semibold text-ink after:absolute after:inset-0 after:content-['']"
                        >
                          {pr.repoFullName}
                          {pr.prNumber ? ` #${pr.prNumber}` : ""}
                        </Link>
                        <p className="flex min-w-0 items-center gap-2 text-sm text-muted">
                          <span className="aos-mono truncate text-xs">{pr.branch}</span>
                          {pr.prUrl ? (
                            <a
                              href={pr.prUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="relative z-10 inline-flex shrink-0 items-center gap-1 font-semibold text-ink underline-offset-4 hover:underline"
                            >
                              GitHub
                              <ExternalLink className="size-3" aria-hidden />
                              <span className="sr-only">(opens in a new tab)</span>
                            </a>
                          ) : null}
                          {pr.continuations > 0 ? (
                            <span className="shrink-0">
                              · {pr.continuations} {pr.continuations === 1 ? "round" : "rounds"} of feedback
                            </span>
                          ) : null}
                        </p>
                      </div>
                      <div className="order-3 flex flex-wrap items-center gap-2 lg:order-none lg:contents">
                        <span className="lg:block">
                          <NeutralBadge label={PR_STATE_LABEL[pr.state] ?? pr.state} size="sm" />
                        </span>
                        <span className="text-sm text-muted lg:block lg:text-md lg:text-ink">{pr.checks ? CHECKS_LABEL[pr.checks] ?? pr.checks : "—"}</span>
                      </div>
                      <div className="order-4 col-span-2 min-w-0 lg:order-none lg:col-span-1">
                        {pr.lastFeedback ? (
                          <>
                            <p className="line-clamp-2 text-sm text-ink">{pr.lastFeedback}</p>
                            <p className="text-xs text-muted tabular-nums">{fmtWhen(pr.lastFeedbackAt)}</p>
                          </>
                        ) : (
                          <p className="text-sm text-muted">No feedback yet</p>
                        )}
                      </div>
                      <ChevronRight size={16} className="hidden text-subtle lg:block" aria-hidden />
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>

      <section aria-labelledby="repo-profiles" className="flex flex-col gap-3">
        <div>
          <h2 id="repo-profiles" className="aos-subheading">
            Repository profiles
          </h2>
          <p className="mt-1 text-sm text-muted">
            Detected on the first clone. run_checks runs these commands; a <span className="aos-mono text-xs">.shapes/profile.json</span> in
            the repository overrides them.
          </p>
        </div>
        {profiles.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-lg bg-paper px-6 py-12 text-center shadow-hairline">
            <FolderGit2 size={28} className="text-subtle" aria-hidden />
            <h3 className="text-base font-semibold text-ink">No repositories cloned yet</h3>
            <p className="max-w-[48ch] text-md text-muted">The first time an agent clones a repository, its stack and check commands appear here.</p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg bg-paper shadow-hairline">
            <div
              aria-hidden
              className="hidden grid-cols-[minmax(0,1fr)_160px_minmax(0,1.4fr)_120px] items-center gap-4 border-b border-line px-5 py-2.5 text-xs font-semibold text-muted lg:grid"
            >
              <span>Repository</span>
              <span>Stack</span>
              <span>Checks</span>
              <span>Detected</span>
            </div>
            <ul>
              {profiles.map((p) => {
                const cmds = (p.commands && typeof p.commands === "object" && !Array.isArray(p.commands) ? p.commands : {}) as Record<string, unknown>;
                const checks = CHECK_ORDER.filter((c) => typeof cmds[c] === "string" && (cmds[c] as string).trim());
                const stack = [p.language, p.packageManager].filter(Boolean).join(" · ") || "Not recognised";
                return (
                  <li key={p.id} className="border-b border-line last:border-0">
                    <div className="grid gap-x-4 gap-y-1.5 px-4 py-3.5 sm:px-5 lg:grid-cols-[minmax(0,1fr)_160px_minmax(0,1.4fr)_120px] lg:items-center">
                      <span className="aos-mono truncate text-sm text-ink">{p.repoFullName}</span>
                      <span className="text-sm text-muted lg:text-md lg:text-ink">{stack}</span>
                      {checks.length ? (
                        <ul className="flex min-w-0 flex-col gap-0.5">
                          {checks.map((c) => (
                            <li key={c} className="flex min-w-0 items-baseline gap-2 text-sm">
                              <span className="w-16 shrink-0 text-muted">{c}</span>
                              <span className="aos-mono truncate text-xs text-ink">{String(cmds[c])}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="text-sm text-muted">No check commands found</span>
                      )}
                      <span className="text-sm text-muted tabular-nums">{fmtWhen(p.updatedAt)}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
