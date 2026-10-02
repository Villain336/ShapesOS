// Marketr — Connector Agent slice 2 API.
// POST /api/connector/import/consent — record the tenant's explicit
// consent grant for one import source (editor). consentedBy defaults to
// the acting user. Re-granting updates the row (consent is refreshed).
// DELETE /api/connector/import/consent?source=email — revoke consent
// (editor). Revoked consent blocks all future imports for the source.
import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaConnectorStore } from "@/lib/connector/prisma-store";
import { ConnectorError, type ConnectorImportSource } from "@/lib/connector/types";

export const dynamic = "force-dynamic";

function connectorErrorResponse(e: ConnectorError) {
  const status = e.code === "no_consent" ? 403 : 400;
  return Response.json({ error: e.message, code: e.code }, { status });
}

export async function POST(req: Request) {
  try {
    const { workspace, user } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as {
      source?: unknown;
      note?: unknown;
      scopes?: unknown;
    };
    const store = new PrismaConnectorStore(prisma);
    const consent = await store.recordSourceConsent(workspace.id, {
      source: body.source,
      consentedBy:
        typeof user.email === "string" && user.email.trim()
          ? user.email
          : user.id,
      note: body.note,
      scopes: body.scopes,
    });
    return Response.json(consent, { status: 201 });
  } catch (e) {
    if (e instanceof ConnectorError) return connectorErrorResponse(e);
    return httpErrorResponse(e);
  }
}

export async function DELETE(req: Request) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const source = new URL(req.url).searchParams.get("source") as
      | ConnectorImportSource
      | null;
    if (!source) {
      return Response.json(
        { error: "source query param is required.", code: "missing_source" },
        { status: 400 },
      );
    }
    const store = new PrismaConnectorStore(prisma);
    const result = await store.revokeSourceConsent(workspace.id, source);
    return Response.json(result);
  } catch (e) {
    if (e instanceof ConnectorError) return connectorErrorResponse(e);
    return httpErrorResponse(e);
  }
}
