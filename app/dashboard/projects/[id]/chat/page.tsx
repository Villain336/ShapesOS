// Marketr — chat page (redesign §3): full-page AI command center + team chat.
// Server page: access check + tabs; panels fetch their own data.

import { accessibleWorkspaceWhere, getMembership, requireProjectRole } from "@/lib/authz";
import Link from "next/link";
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

  const membership = await getMembership(user.id, project.workspaceId);
  const canEdit = (await requireProjectRole(user.id, project.id, "editor")) !== null;
  const memberCount = await prisma.workspaceMember.count({
    where: { workspaceId: project.workspaceId },
  });
  const mockMode = !llmStatus().isLive;

  const sp = await searchParams;
  const initialTab = sp.tab === "team" ? ("team" as const) : ("ai" as const);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/dashboard/projects/${project.id}`} className="text-sm text-zinc-500 hover:text-zinc-700">
          ← {project.domain}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-zinc-900">Chat</h1>
        <p className="mt-1 text-sm text-zinc-500">
          {membership
            ? "Talk to Marketr's AI assistant — it reads your project and executes actions — or message the project team."
            : "Chat for this project."}
        </p>
      </div>

      <ChatTabs
        projectId={project.id}
        canEdit={canEdit}
        mockMode={mockMode}
        memberCount={memberCount}
        currentUserId={user.id}
        initialTab={initialTab}
      />
    </div>
  );
}
