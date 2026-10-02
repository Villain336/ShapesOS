// Marketr — Connector Agent slice 2 API.
// DELETE /api/connector/import/exclusions/[id] — remove one exclusion
// rule (editor). Tenant-scoped: another workspace's rule id returns
// { removed: false }, never an error or a cross-tenant delete.
import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaConnectorStore } from "@/lib/connector/prisma-store";
import { ConnectorError } from "@/lib/connector/types";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const store = new PrismaConnectorStore(prisma);
    const result = await store.removeExclusion(workspace.id, id);
    return Response.json(result);
  } catch (e) {
    if (e instanceof ConnectorError) {
      return Response.json({ error: e.message, code: e.code }, { status: 400 });
    }
    return httpErrorResponse(e);
  }
}
