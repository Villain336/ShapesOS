// Marketr — content engine list page (spec §5 flow 3).

import { accessibleWorkspaceWhere } from "@/lib/authz";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import ContentList from "@/components/ContentList";
import GapHandoffBanner from "./_components/GapHandoffBanner";

export const dynamic = "force-dynamic";

export default async function ContentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    gapKeyword?: string;
    gapEngines?: string;
    gapCompetitors?: string;
    gapFacts?: string;
  }>;
}) {
  const user = await requireUser();
  if (!user) return null; // layout already redirects
  const { id } = await params;
  const gap = await searchParams;

  const project = await prisma.project.findFirst({
    where: { id, workspace: accessibleWorkspaceWhere(user.id) },
    include: {
      keywords: {
        orderBy: [{ list: "asc" }, { volume: "desc" }],
        select: { id: true, phrase: true, volume: true },
      },
      contentItems: {
        orderBy: { updatedAt: "desc" },
        select: {
          id: true,
          status: true,
          seoScore: true,
          updatedAt: true,
          keyword: { select: { phrase: true } },
        },
      },
    },
  });
  if (!project) notFound();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href={`/dashboard/projects/${project.id}`}
          className="text-sm text-zinc-500 hover:text-zinc-600"
        >
          ← {project.domain}
        </Link>
        <h1 className="mt-1 text-xl font-bold tracking-tight text-ink">
          Content engine
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          Brief → draft → edit → publish.
        </p>
      </div>
      {/* M3 citation-gap handoff: the gap context arrives here via deep link.
          The banner is read-only — the brief is built by the normal flow
          (save the keyword → Create brief) fed with the handoff inputs. */}
      {gap.gapKeyword && (
        <GapHandoffBanner
          handoff={{
            keyword: gap.gapKeyword,
            engines: gap.gapEngines ?? "",
            competitors: gap.gapCompetitors ?? "",
            facts: gap.gapFacts ?? "",
          }}
        />
      )}
      <ContentList
        projectId={project.id}
        keywords={project.keywords}
        items={project.contentItems.map((i) => ({
          ...i,
          updatedAt: i.updatedAt.toISOString(),
        }))}
      />
    </div>
  );
}
