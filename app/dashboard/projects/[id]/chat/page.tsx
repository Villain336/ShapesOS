// Marketr — chat page (redesign §3): full-page AI command center + team chat.
// Server page: access check + tabs; panels fetch their own data.

import { accessibleWorkspaceWhere, getMembership, requireProjectRole } from "@/lib/authz";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { llmStatus } from "@/lib/llm";
import ChatTabs from "@/components/ChatTabs";
import { PageHeader } from "@/components/vault/PageHeader";

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
      <PageHeader
        title="Chat"
        description={
          membership
            ? "Talk to Marketr's AI assistant — it reads your project and executes actions — or message the project team."
            : "Chat for this project."
        }
        actions={
          <Link
            href={`/dashboard/projects/${project.id}`}
            className="inline-flex items-center gap-1.5 text-[13px] font-medium text-ink-2 transition-colors duration-150 hover:text-ink"
          >
            <ArrowLeft size={14} strokeWidth={2} />
            {project.domain}
          </Link>
        }
      />

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
