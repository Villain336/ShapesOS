// Marketr — replay viewer (Phase 12 "embeds", rrweb).
// GET /s/[token]/replay — workspace-authenticated viewer for the session
// recordings of an opt-in share link. Session list is server-rendered;
// the Replayer is lazy-loaded client-side.

import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, MonitorPlay } from "lucide-react";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { hashShareToken } from "@/lib/design/sharing";
import { prisma } from "@/lib/prisma";
import { ReplayViewer } from "@/components/replay/ReplayViewer";

export const dynamic = "force-dynamic";

export default async function ShareReplayPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ session?: string }>;
}) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const { token } = await params;
  const { session: sessionId } = await searchParams;

  const share = await prisma.designShare.findUnique({
    where: { tokenHash: hashShareToken(token) },
    select: {
      id: true,
      workspaceId: true,
      replayOptIn: true,
      revokedAt: true,
      expiresAt: true,
      design: { select: { id: true, name: true } },
    },
  });
  const active =
    share &&
    share.workspaceId === workspace.id &&
    share.replayOptIn &&
    !share.revokedAt &&
    (!share.expiresAt || share.expiresAt > new Date());
  if (!active || !share) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
        <div className="rounded-lg bg-paper p-8 text-center shadow-hairline">
          <MonitorPlay className="mx-auto h-8 w-8 text-muted" />
          <h1 className="mt-3 text-xl font-heading tracking-heading stretch-heading text-ink">
            No replay available
          </h1>
          <p className="mt-1 text-[0.8125rem] text-muted">
            This share link doesn&apos;t exist, has expired, or didn&apos;t opt
            in to session replay.
          </p>
        </div>
      </div>
    );
  }

  const sessions = await prisma.designReplaySession.findMany({
    where: { shareId: share.id },
    orderBy: { startedAt: "desc" },
    select: { id: true, startedAt: true, endedAt: true },
  });

  return (
    <div className="min-h-screen bg-canvas px-4 py-8 md:px-8">
      <div className="mx-auto max-w-5xl">
        <Link
          href={`/s/${encodeURIComponent(token)}`}
          className="inline-flex items-center gap-1 text-[0.8125rem] text-muted hover:text-ink"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to preview
        </Link>
        <h1 className="mt-2 text-xl font-heading tracking-heading stretch-heading text-ink">
          Session replay
        </h1>
        <p className="mt-0.5 text-[0.8125rem] text-muted">
          {share.design.name} — recordings are opt-in per share link and only
          visible to your workspace. Inputs are masked in every recording.
        </p>
        <div className="mt-4">
          <ReplayViewer
            token={token}
            sessions={sessions.map((s) => ({
              id: s.id,
              startedAt: s.startedAt.toISOString(),
              endedAt: s.endedAt?.toISOString() ?? null,
            }))}
            initialSessionId={sessionId ?? null}
          />
        </div>
      </div>
    </div>
  );
}
