// Marketr — project settings: Files (milestone 21, part D2).
// Server: this project's file attachments (uploads + connector references)
// and its bound data sources (for the "reference from connector" form).
// Uploads/reference/delete go through the files API.

import { redirect, notFound } from "next/navigation";
import { Card, CardBody, CardHeader } from "@/components/vault/Card";
import { accessibleWorkspaceWhere, requireProjectRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import FilesClient from "./FilesClient";

export const dynamic = "force-dynamic";

function prettyKey(key: string): string {
  return key
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export default async function FilesSettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const { id } = await params;

  const project = await prisma.project.findFirst({
    where: { id, workspace: accessibleWorkspaceWhere(user.id) },
    select: { id: true },
  });
  if (!project) notFound();
  if (!(await requireProjectRole(user.id, project.id, "viewer"))) redirect("/dashboard");
  const canEdit = (await requireProjectRole(user.id, project.id, "editor")) !== null;

  const [files, bindings] = await Promise.all([
    prisma.fileAttachment.findMany({
      where: { projectId: project.id },
      select: {
        id: true,
        filename: true,
        mimeType: true,
        sizeBytes: true,
        source: true,
        connectorKey: true,
        sessionId: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    prisma.projectDataSource.findMany({
      where: { projectId: project.id },
      select: {
        id: true,
        connectorKey: true,
        connection: { select: { connector: { select: { displayName: true } } } },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const initialFiles = files.map((f) => ({
    id: f.id,
    filename: f.filename,
    mimeType: f.mimeType,
    sizeBytes: f.sizeBytes,
    source: f.source,
    connectorKey: f.connectorKey,
    sessionId: f.sessionId,
    createdAt: f.createdAt.toISOString(),
  }));

  const connectorOptions = bindings.map((b) => ({
    connectorKey: b.connectorKey,
    displayName: b.connection.connector?.displayName ?? prettyKey(b.connectorKey),
  }));

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <Card>
        <CardHeader
          title="Project files"
          description="Attached to this project — ShapesOS reads them on reference only, nothing is indexed"
        />
        <CardBody>
          <FilesClient
            projectId={project.id}
            canEdit={canEdit}
            initialFiles={initialFiles}
            connectorOptions={connectorOptions}
          />
        </CardBody>
      </Card>
    </div>
  );
}
