// Marketr — chat page: full-bleed AI command center + team chat.
// Server page: access check; the shell (ChatTabs) owns the layout — no page
// header per design-v2.

import { accessibleWorkspaceWhere, requireProjectRole } from "@/lib/authz";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { llmStatus } from "@/lib/llm";
import ChatTabs from "@/components/ChatTabs";

export const dynamic = "force-dynamic";

export default async function ChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const user = await requireUser();
  if (!user) return null;
  const { id } = await params;
  const project = await prisma.project.findFirst({
    where: { id, workspace: accessibleWorkspaceWhere(user.id) },
    select: { id: true, workspaceId: true, domain: true },
  });
  if (!project) notFound();
  if (!(await requireProjectRole(user.id, project.id, "viewer"))) notFound();

  const canEdit = (await requireProjectRole(user.id, project.id, "editor")) !== null;
  const memberCount = await prisma.workspaceMember.count({
    where: { workspaceId: project.workspaceId },
  });
  const mockMode = !llmStatus().isLive;

  const sp = await searchParams;
  const initialTab = sp.tab === "team" ? ("team" as const) : ("ai" as const);

  return (
    <div className="h-full">
      <ChatTabs
        projectId={project.id}
        projectDomain={project.domain}
        canEdit={canEdit}
        mockMode={mockMode}
        memberCount={memberCount}
        currentUserId={user.id}
        initialTab={initialTab}
      />
    </div>
  );
}
