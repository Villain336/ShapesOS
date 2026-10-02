// Marketr — Connector Agent slice 2 API.
// GET /api/connector/import/exclusions — the tenant's exclusion list.
// POST /api/connector/import/exclusions — add a rule (editor):
//   { type: "domain" | "email" | "person_name", value, note? }
// Excluded contacts never become Persons — the engine checks before
// creating any Person row.
import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaConnectorStore } from "@/lib/connector/prisma-store";
import { ConnectorError } from "@/lib/connector/types";

export const dynamic = "force-dynamic";

function connectorErrorResponse(e: ConnectorError) {
  const status = e.code === "duplicate_exclusion" ? 409 : 400;
  return Response.json({ error: e.message, code: e.code }, { status });
}

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const store = new PrismaConnectorStore(prisma);
    const exclusions = await store.listExclusions(workspace.id);
    return Response.json({ exclusions });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as {
      type?: unknown;
      value?: unknown;
      note?: unknown;
    };
    const store = new PrismaConnectorStore(prisma);
    const exclusion = await store.addExclusion(workspace.id, body);
    return Response.json(exclusion, { status: 201 });
  } catch (e) {
    if (e instanceof ConnectorError) return connectorErrorResponse(e);
    return httpErrorResponse(e);
  }
}
