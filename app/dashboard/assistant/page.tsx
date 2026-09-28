// Marketr — global AI assistant. The assistant is a first-class feature:
// one page for every project, with a project switcher in the top strip.
// Server: resolve the project (?project= or first), access checks, then the
// client shell owns the layout — no page header per design-v2.

import { redirect } from "next/navigation";
import { requireProjectRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { llmStatus } from "@/lib/llm";
import AssistantClient from "@/components/chat/AssistantClient";

export const dynamic = "force-dynamic";

export default async function AssistantPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; tab?: string }>;
}) {
  const user = await requireUser();
  if (!user) return null;
  const workspace = await getOrCreateWorkspace(user.id, user.email);

  const projects = await prisma.project.findMany({
    where: { workspaceId: workspace.id },
    select: { id: true, domain: true },
    orderBy: { createdAt: "asc" },
  });
  if (projects.length === 0) redirect("/dashboard");

  const sp = await searchParams;
  const project = projects.find((p) => p.id === sp.project) ?? projects[0]!;
  if (!(await requireProjectRole(user.id, project.id, "viewer"))) redirect("/dashboard");

  const canEdit = (await requireProjectRole(user.id, project.id, "editor")) !== null;
  const memberCount = await prisma.workspaceMember.count({
    where: { workspaceId: workspace.id },
  });
  const mockMode = !llmStatus().isLive;
  const initialTab = sp.tab === "team" ? ("team" as const) : ("ai" as const);

  return (
    <div className="h-full">
      <AssistantClient
        project={project}
        projects={projects}
        canEdit={canEdit}
        mockMode={mockMode}
        memberCount={memberCount}
        currentUserId={user.id}
        initialTab={initialTab}
        workspaceId={workspace.id}
      />
    </div>
  );
}
