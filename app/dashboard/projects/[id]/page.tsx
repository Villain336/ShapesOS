// Marketr — project detail: saved-keyword overview + entry points.

import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import DeleteProjectButton from "@/components/DeleteProjectButton";

export const dynamic = "force-dynamic";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  if (!user) return null; // layout already redirects
  const { id } = await params;

  const project = await prisma.project.findFirst({
    where: { id, workspace: { ownerUserId: user.id } },
    include: {
      keywords: { orderBy: [{ list: "asc" }, { volume: "desc" }] },
      competitors: { select: { id: true } },
      contentItems: { select: { id: true } },
      _count: { select: { keywords: { where: { tracked: true } } } },
    },
  });
  if (!project) notFound();

  const trackedCount = project._count.keywords;

  const lists = new Map<string, number>();
  for (const k of project.keywords) {
    lists.set(k.list ?? "Saved keywords", (lists.get(k.list ?? "Saved keywords") ?? 0) + 1);
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-start justify-between">
        <div>
          <Link
            href="/dashboard"
            className="text-sm text-zinc-500 hover:text-zinc-300"
          >
            ← Projects
          </Link>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">
            {project.domain}
          </h1>
          <p className="mt-1 text-sm text-zinc-400">
            {project.keywords.length} keywords saved ·{" "}
            {trackedCount} tracked ·{" "}
            {project.competitors.length} competitor
            {project.competitors.length === 1 ? "" : "s"} ·{" "}
            {project.contentItems.length} content item
            {project.contentItems.length === 1 ? "" : "s"} · {project.locale}
          </p>
        </div>
        <DeleteProjectButton projectId={project.id} />
      </div>

      <div className="flex gap-3">
        <Link
          href={`/dashboard/projects/${project.id}/keywords`}
          className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-white"
        >
          Keyword research →
        </Link>
        <Link
          href={`/dashboard/projects/${project.id}/competitors`}
          className="rounded-md border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 hover:border-zinc-500"
        >
          Competitor gaps →
        </Link>
        <Link
          href={`/dashboard/projects/${project.id}/content`}
          className="rounded-md border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 hover:border-zinc-500"
        >
          Content engine →
        </Link>
        <Link
          href={`/dashboard/projects/${project.id}/rankings`}
          className="rounded-md border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 hover:border-zinc-500"
        >
          Rank tracking →
        </Link>
      </div>

      <div>
        <h2 className="mb-3 text-sm font-medium uppercase tracking-widest text-zinc-500">
          Keyword lists
        </h2>
        {lists.size === 0 ? (
          <p className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">
            Nothing saved yet. Run keyword research and save winners to a
            list.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {[...lists.entries()].map(([name, count]) => (
              <li
                key={name}
                className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/60 px-5 py-3"
              >
                <span className="font-medium">{name}</span>
                <span className="text-sm text-zinc-500">
                  {count} keyword{count === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
