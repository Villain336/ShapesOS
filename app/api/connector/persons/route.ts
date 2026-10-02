// Marketr — Connector Agent slice 1 API.
// POST /api/connector/persons — manually add a person to the tenant's graph
// (editor role). Provenance is mandatory: consentedBy is required; a
// manual add records the founder as the consenter.
import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaConnectorStore } from "@/lib/connector/prisma-store";
import { ConnectorError, type PersonInput } from "@/lib/connector/types";

export const dynamic = "force-dynamic";

function connectorErrorResponse(e: ConnectorError) {
  const status =
    e.code === "batch_not_found" || e.code === "person_not_found" ? 404 : 400;
  return Response.json({ error: e.message, code: e.code }, { status });
}

export async function POST(req: Request) {
  try {
    const { workspace, user } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as PersonInput;
    const store = new PrismaConnectorStore(prisma);
    // Manual adds default the consenter to the acting user.
    const created = await store.addPerson(workspace.id, {
      ...body,
      consentedBy:
        typeof body.consentedBy === "string" && body.consentedBy.trim()
          ? body.consentedBy
          : (user.email ?? user.id),
    });
    return Response.json(created, { status: 201 });
  } catch (e) {
    if (e instanceof ConnectorError) return connectorErrorResponse(e);
    return httpErrorResponse(e);
  }
}
