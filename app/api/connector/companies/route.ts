// Marketr — Connector Agent slice 1 API.
// POST /api/connector/companies — add a company node (editor role).
// One company name per tenant.
import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaConnectorStore } from "@/lib/connector/prisma-store";
import { ConnectorError, type CompanyInput } from "@/lib/connector/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as CompanyInput;
    const store = new PrismaConnectorStore(prisma);
    const created = await store.addCompany(workspace.id, body);
    return Response.json(created, { status: 201 });
  } catch (e) {
    if (e instanceof ConnectorError) {
      const status =
        e.code === "duplicate_company" ? 409 : 400;
      return Response.json({ error: e.message, code: e.code }, { status });
    }
    return httpErrorResponse(e);
  }
}
