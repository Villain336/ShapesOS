// ShapesOS — Phase 9 (apps): /dashboard/apps/[slug]/build — edit the draft spec.
// Editors and up edit and save the draft; admins and up publish it (the
// approval step for an agent-drafted app). Viewers are sent to the app.

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { TOOL_GROUP } from "@/lib/chat/tools";
import { TOOL_GROUPS, TOOL_GROUP_LABELS } from "@/lib/agents/grants";
import { AppError, loadApp } from "@/lib/apps/service";
import { roleMeets } from "@/lib/apps/spec";
import { pageActor } from "../../_components/actor";
import { AppBuilder } from "../../_components/AppBuilder";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return { title: `Build ${slug} — Apps — ShapesOS` };
}

export default async function BuildAppPage({ params }: { params: Promise<{ slug: string }> }) {
  const actor = await pageActor();
  const { slug } = await params;
  if (!roleMeets(actor.role, "editor")) redirect(`/dashboard/apps/${slug}`);

  let app;
  try {
    app = await loadApp(actor, slug);
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound();
    throw e;
  }

  // Workflows (lib/workflow) in this workspace's projects, for run_workflow actions.
  const workflows = await prisma.workflow.findMany({
    where: { project: { workspaceId: actor.workspaceId } },
    orderBy: { updatedAt: "desc" },
    take: 200,
    select: { id: true, name: true, project: { select: { domain: true } } },
  });
  // Agent tools an app may call (never the app tools or hand-offs).
  const tools = Object.entries(TOOL_GROUP)
    .filter(([name, group]) => !name.startsWith("app_") && group !== "delegate")
    .map(([name, group]) => ({ name, group }));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-sm text-muted">
          <Link href="/dashboard/apps" className="font-semibold text-ink underline-offset-4 hover:underline">
            Apps
          </Link>
        </p>
        <h1 className="aos-heading mt-1">Build {app.name}</h1>
        <p className="mt-1 text-md text-muted">
          Shape the draft: what it stores, how people see it and what they can do. Changes stay in the draft until {roleMeets(actor.role, "admin") ? "you publish" : "an admin publishes"} them.
        </p>
      </div>
      <AppBuilder
        slug={app.slug}
        draft={app.draftSpec!}
        published={app.published}
        version={app.version}
        hasDraftChanges={app.hasDraftChanges}
        canPublish={roleMeets(actor.role, "admin")}
        workflows={workflows.map((w) => ({ id: w.id, name: `${w.name} (${w.project.domain})` }))}
        tools={tools}
        toolGroups={TOOL_GROUPS.filter((g) => g !== "delegate" && g !== "workspace").map((g) => ({ value: g, label: TOOL_GROUP_LABELS[g] }))}
      />
    </div>
  );
}
