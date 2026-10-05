// ShapesOS — SEO projects index. Every project (domain) in the workspace,
// with its keyword / content / automation counts and latest visibility
// score. Previously only reachable from the Overview list; the sidebar's
// Grow → SEO projects row lands here.

import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronRight, Search } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import ProjectCreateForm from "@/components/ProjectCreateForm";
import { Card, CardBody } from "@/components/vault/Card";
import { EmptyState } from "@/components/vault/EmptyState";
import { ValuePill } from "@/components/vault/atoms/ValuePill";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "SEO projects — ShapesOS",
  description: "Your sites: keyword research, rankings, content and automations per domain.",
};

export default async function ProjectsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);

  const projects = await prisma.project.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { keywords: true, contentItems: true, workflows: true } },
    },
  });
  const scores = projects.length
    ? await prisma.visibilityScore.findMany({
        where: { projectId: { in: projects.map((p) => p.id) } },
        orderBy: { date: "desc" },
        distinct: ["projectId"],
      })
    : [];
  const scoreByProject = new Map(scores.map((s) => [s.projectId, s.score]));

  return (
    <div className="flex flex-col gap-4 bg-canvas p-4 md:p-6">
      <div>
        <h1 className="aos-heading">SEO projects</h1>
        <p className="mt-0.5 text-sm text-muted">
          {projects.length} project{projects.length === 1 ? "" : "s"} in {workspace.name}. Open one
          for keywords, rankings, content and automations.
        </p>
      </div>

      <Card>
        <CardBody className="p-0">
          {projects.length === 0 ? (
            <EmptyState
              icon={<Search className="size-5" />}
              title="No projects yet"
              description="Add a domain below to start keyword research, track rankings and generate content."
            />
          ) : (
            <ul className="flex flex-col">
              {projects.map((p) => {
                const score = scoreByProject.get(p.id);
                return (
                  <li key={p.id} className="border-b border-line last:border-b-0">
                    <Link
                      href={`/dashboard/projects/${p.id}`}
                      className="group flex items-center justify-between gap-3 rounded-sm px-4 py-3.5 transition-[background-color] duration-150 hover:bg-hover-paper"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-base font-medium text-ink">{p.domain}</span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm text-muted">
                          <ValuePill>
                            {p._count.keywords} keyword{p._count.keywords === 1 ? "" : "s"}
                          </ValuePill>
                          <ValuePill>{p._count.contentItems} content</ValuePill>
                          <ValuePill>
                            {p._count.workflows} automation{p._count.workflows === 1 ? "" : "s"}
                          </ValuePill>
                          <span className="text-subtle">{p.locale}</span>
                        </span>
                      </span>
                      {score !== undefined ? (
                        <span
                          className="flex size-11 shrink-0 flex-col items-center justify-center rounded-md bg-canvas shadow-hairline"
                          title={`Visibility score ${score}/100`}
                        >
                          <span className="text-base font-semibold tabular-nums text-ink">{score}</span>
                          <span className="text-2xs leading-none text-subtle">score</span>
                        </span>
                      ) : null}
                      <ChevronRight
                        aria-hidden
                        className="size-4 shrink-0 text-subtle transition-transform duration-150 group-hover:translate-x-0.5"
                      />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </CardBody>
      </Card>

      <ProjectCreateForm />
    </div>
  );
}
