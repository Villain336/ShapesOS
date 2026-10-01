// Marketr — Wave 2 WFH mode slice 4: async standups page.
//
// Written yesterday/today/blockers updates with optional video, team
// visibility, and a comment/reaction thread. Missing a day is a nudge,
// never a mandate.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import WfhTabs from "../_components/WfhTabs";
import StandupsPanel from "./_components/StandupsPanel";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "WFH async standups — Marketr",
  description: "Written standups with team visibility, comments, and reactions.",
};

export default async function WfhStandupsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  const standups = await prisma.wfhStandup.findMany({
    where: {
      workspaceId: workspace.id,
      OR: [{ visibility: "team" }, { userId: user.id }],
    },
    include: {
      comments: { orderBy: { createdAt: "asc" } },
      reactions: true,
    },
    orderBy: { date: "desc" },
    take: 30,
  });

  return (
    <div className="bg-canvas p-4 md:p-6">
      <h1 className="aos-heading">WFH mode</h1>
      <p className="mt-1 text-sm text-muted">
        Async standups: yesterday, today, blockers — written, visible to the team,
        with a comment and reaction thread. No meeting required.
      </p>
      <div className="mt-3">
        <WfhTabs active="standups" />
      </div>
      <div className="mt-4">
        <StandupsPanel
          initialStandups={standups.map((s) => ({
            id: s.id,
            userId: s.userId,
            date: s.date.toISOString(),
            yesterday: s.yesterday,
            today: s.today,
            blockers: s.blockers,
            videoUrl: s.videoUrl,
            visibility: s.visibility,
            comments: s.comments.map((c) => ({
              id: c.id,
              userId: c.userId,
              body: c.body,
              createdAt: c.createdAt.toISOString(),
            })),
            reactions: s.reactions.map((r) => ({ userId: r.userId, emoji: r.emoji })),
          }))}
          me={user.id}
        />
      </div>
    </div>
  );
}
