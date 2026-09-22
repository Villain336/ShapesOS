// Marketr — social studio (milestone 20).
// Server page with a client studio island (calendar, composer, posts,
// channels, settings). Viewer role is read-only; editor+ can schedule/publish.

import { accessibleWorkspaceWhere, requireProjectRole } from "@/lib/authz";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { getSocialSettings, sanitizeContent } from "@/lib/social/service";
import { CHANNEL_DEFS, type SocialService } from "@/lib/social/channels";
import SocialStudio, { type StudioPost } from "@/components/SocialStudio";

export const dynamic = "force-dynamic";

export default async function SocialPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return null;
  const { id } = await params;
  const project = await prisma.project.findFirst({
    where: { id, workspace: accessibleWorkspaceWhere(user.id) },
    select: { id: true, workspaceId: true },
  });
  if (!project) notFound();

  const canEdit = !!(await requireProjectRole(user.id, project.id, "editor"));

  const [channels, posts, settings] = await Promise.all([
    prisma.socialChannel.findMany({
      where: { projectId: project.id },
      orderBy: [{ service: "asc" }, { handle: "asc" }],
    }),
    prisma.socialPost.findMany({
      where: { projectId: project.id },
      orderBy: [{ scheduledFor: "asc" }, { createdAt: "desc" }],
      take: 200,
    }),
    getSocialSettings(prisma, project.workspaceId),
  ]);

  const studioPosts: StudioPost[] = posts.map((p) => ({
    id: p.id,
    content: sanitizeContent(p.content),
    services: p.services,
    serviceLabels: p.services.map((s) => CHANNEL_DEFS[s as SocialService]?.label ?? s),
    scheduledFor: p.scheduledFor?.toISOString() ?? null,
    status: p.status,
    bufferUpdateIds: p.bufferUpdateIds,
    attempts: p.attempts,
    nextAttemptAt: p.nextAttemptAt?.toISOString() ?? null,
    error: p.error,
    stats: p.stats,
    statsSyncedAt: p.statsSyncedAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  }));

  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900">Social</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Content calendar and scheduled publishing through Buffer.
          </p>
        </div>
        <Link
          href={`/dashboard/projects/${project.id}`}
          className="rounded-md border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-800 hover:border-zinc-400"
        >
          ← Project
        </Link>
      </div>
      <SocialStudio
        projectId={project.id}
        channels={channels.map((c) => ({
          id: c.id,
          bufferProfileId: c.bufferProfileId,
          service: c.service,
          handle: c.handle,
          enabled: c.enabled,
        }))}
        posts={studioPosts}
        connected={!!settings?.bufferTokenEnc}
        tokenHint={settings?.bufferTokenHint ?? null}
        canEdit={canEdit}
      />
    </main>
  );
}
