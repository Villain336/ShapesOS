// Marketr — share replay viewer, dashboard edition (Phase 12 "embeds", rrweb).
// GET /dashboard/studio/designs/[id]/replay/[shareId]
// Workspace-authenticated: workspace members open session recordings from the
// share-management UI ("View replay") without handling the raw shown-once token.

import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, MonitorPlay } from "lucide-react";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { ReplayViewer } from "@/components/replay/ReplayViewer";
import { listReplaySessions } from "@/lib/integrations/replay";

export const dynamic = "force-dynamic";

export default async function DashboardShareReplayPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; shareId: string }>;
  searchParams: Promise<{ session?: string }>;
}) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const { id: designId, shareId } = await params;
  const { session: sessionId } = await searchParams;

  const share = await prisma.designShare.findFirst({
    where: {
      id: shareId,
      designId,
      workspaceId: workspace.id,
      replayOptIn: true,
      revokedAt: null,
    },
    select: {
      id: true,
      expiresAt: true,
      design: { select: { id: true, name: true } },
    },
  });
  const active = share && (!share.expiresAt || share.expiresAt > new Date());
  if (!active || !share) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center bg-canvas px-4">
        <div className="rounded-lg bg-paper p-8 text-center shadow-hairline">
          <MonitorPlay className="mx-auto h-8 w-8 text-subtle" />
          <h1 className="aos-heading mt-3 text-ink">
            No replay available
          </h1>
          <p className="mt-1 text-[13px] text-muted">
            This share link doesn&apos;t exist, has expired, or didn&apos;t opt in to
            session replay.
          </p>
        </div>
      </div>
    );
  }

  const sessions = await listReplaySessions(share.id);
  const eventsBase = `/api/studio/designs/${encodeURIComponent(designId)}/shares/${encodeURIComponent(share.id)}/replay`;

  return (
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <Link
        href={`/dashboard/studio/designs/${encodeURIComponent(designId)}`}
        className="inline-flex w-fit items-center gap-1 text-[13px] text-muted hover:text-ink"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to design
      </Link>
      <div>
        <h1 className="aos-heading text-ink">Session replay</h1>
        <p className="mt-0.5 max-w-2xl text-[13px] text-muted">
          {share.design.name} — recordings are opt-in per share link and only visible to
          your workspace. Inputs are masked in every recording.
        </p>
      </div>
      <ReplayViewer
        token=""
        eventsBase={eventsBase}
        sessions={sessions.map((s) => ({
          id: s.id,
          startedAt: s.startedAt.toISOString(),
          endedAt: s.endedAt?.toISOString() ?? null,
        }))}
        initialSessionId={sessionId ?? null}
      />
    </div>
  );
}
