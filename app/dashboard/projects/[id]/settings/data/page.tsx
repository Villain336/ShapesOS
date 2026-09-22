// Marketr — project settings: Data (milestone 21, part D2).
// Server: this project's bound data sources (ProjectDataSource + the owning
// connection) and the workspace's active connections available to bind.
// Mutations go through the data-sources API.

import { redirect, notFound } from "next/navigation";
import { Card, CardBody, CardHeader } from "@/components/vault/Card";
import { accessibleWorkspaceWhere, requireProjectRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import DataClient from "./DataClient";

export const dynamic = "force-dynamic";

function prettyKey(key: string): string {
  return key
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export default async function DataSettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const { id } = await params;

  const project = await prisma.project.findFirst({
    where: { id, workspace: accessibleWorkspaceWhere(user.id) },
    select: { id: true, workspaceId: true },
  });
  if (!project) notFound();
  if (!(await requireProjectRole(user.id, project.id, "viewer"))) redirect("/dashboard");
  const canEdit = (await requireProjectRole(user.id, project.id, "editor")) !== null;

  const [bindings, connections] = await Promise.all([
    prisma.projectDataSource.findMany({
      where: { projectId: project.id },
      include: {
        connection: {
          select: {
            id: true,
            connectorKey: true,
            status: true,
            meta: true,
            connector: { select: { displayName: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.connectorConnection.findMany({
      where: { workspaceId: project.workspaceId, status: "active" },
      select: {
        id: true,
        connectorKey: true,
        meta: true,
        connector: { select: { displayName: true } },
      },
      orderBy: { connectedAt: "desc" },
    }),
  ]);

  const initialBindings = bindings.map((b) => ({
    id: b.id,
    connectorKey: b.connectorKey,
    displayName: b.connection.connector?.displayName ?? prettyKey(b.connectorKey),
    connectionId: b.connection.id,
    status: String(b.connection.status),
    meta: (b.connection.meta as Record<string, unknown> | null) ?? null,
    projectConfig: (b.projectConfig as Record<string, unknown> | null) ?? null,
  }));

  const availableConnections = connections.map((c) => ({
    id: c.id,
    connectorKey: c.connectorKey,
    displayName: c.connector?.displayName ?? prettyKey(c.connectorKey),
    meta: (c.meta as Record<string, unknown> | null) ?? null,
  }));

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <Card>
        <CardHeader
          title="Bound data sources"
          description="Workspace connections wired into this project — other projects can't see them"
        />
        <CardBody>
          <DataClient
            projectId={project.id}
            canEdit={canEdit}
            initialBindings={initialBindings}
            availableConnections={availableConnections}
          />
        </CardBody>
      </Card>
    </div>
  );
}
