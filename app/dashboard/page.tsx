// Marketr — dashboard home: workspace summary + project list + create form.

import Link from "next/link";
import { ChevronRight, Database, FolderKanban, Globe, KeyRound } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { providerStatus } from "@/lib/providers";
import ProjectCreateForm from "@/components/ProjectCreateForm";
import { PageHeader } from "@/components/vault/PageHeader";
import { Stat } from "@/components/vault/Stat";
import { Card, CardBody, CardHeader } from "@/components/vault/Card";
import { EmptyState } from "@/components/vault/EmptyState";
import { ValuePill } from "@/components/vault/atoms/ValuePill";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await requireUser();
  if (!user) return null; // layout already redirects

  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const projects = await prisma.project.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { keywords: true } } },
  });
  const provider = providerStatus();

  const totalKeywords = projects.reduce((sum, p) => sum + p._count.keywords, 0);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={workspace.name}
        description={
          <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
            Plan <ValuePill>{workspace.plan}</ValuePill>
            <span aria-hidden>·</span>
            Data provider{" "}
            <ValuePill tone={provider.isLive ? "green" : "orange"}>
              {provider.isLive ? "DataForSEO (live)" : "Mock"}
            </ValuePill>
            {provider.isLive ? null : (
              <span className="text-ink-3">
                — add DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD to .env for live data
              </span>
            )}
          </span>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat
          label="Projects"
          value={projects.length}
          icon={<FolderKanban className="size-4" />}
        />
        <Stat
          label="Keywords saved"
          value={totalKeywords}
          icon={<KeyRound className="size-4" />}
        />
        <Stat
          label="Data provider"
          value={provider.isLive ? "DataForSEO" : "Mock"}
          delta={provider.isLive ? "Live" : "Add credentials"}
          deltaTone={provider.isLive ? "up" : "neutral"}
          icon={<Database className="size-4" />}
        />
      </div>

      <ProjectCreateForm />

      <Card>
        <CardHeader title="Projects" description="Open a project to dig into its workspaces" />
        <CardBody className="p-0">
          {projects.length === 0 ? (
            <EmptyState
              icon={<Globe className="size-5" />}
              title="No projects yet"
              description="Add a domain above to start keyword research."
            />
          ) : (
            <ul className="flex flex-col">
              {projects.map((p) => (
                <li key={p.id} className="border-b border-line last:border-b-0">
                  <Link
                    href={`/dashboard/projects/${p.id}`}
                    className="group flex items-center justify-between gap-3 px-4 py-3.5 transition-[background-color] duration-150 ease-[cubic-bezier(0.2,0,0,1)] hover:bg-hover active:scale-[0.99]"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[14px] font-medium text-ink">
                        {p.domain}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-ink-2">
                        <ValuePill>
                          {p._count.keywords} keyword{p._count.keywords === 1 ? "" : "s"} saved
                        </ValuePill>
                        <span className="text-ink-3">{p.locale}</span>
                      </span>
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-ink-3 transition-transform duration-150 ease-[cubic-bezier(0.2,0,0,1)] group-hover:translate-x-0.5" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
