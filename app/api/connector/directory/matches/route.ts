// Marketr — Connector Agent slice 6 API.
// GET /api/connector/directory/matches — mutually-discoverable directory
//   matches (viewer role). ?roleKeywords=a,b&industries=x,y&lookingFor=leads&limit=20
//   Throws not_discoverable (400) when the viewer's own profile is not
//   published — matching requires mutual discoverability. Candidates that
//   are not discoverable are never matched; only published profile facets
//   are exposed. NO cross-tenant private-graph reads.
import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaConnectorStore } from "@/lib/connector/prisma-store";
import { ConnectorError } from "@/lib/connector/types";
import { introErrorResponse } from "../../intros/intro-error";

export const dynamic = "force-dynamic";

function listParam(value: string | null): string[] | undefined {
  if (!value) return undefined;
  const parts = value.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

export async function GET(req: Request) {
  try {
    const { workspace } = await guardWorkspace();
    const url = new URL(req.url);
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    const store = new PrismaConnectorStore(prisma);
    const matches = await store.findDirectoryMatches(workspace.id, {
      roleKeywords: listParam(url.searchParams.get("roleKeywords")),
      industries: listParam(url.searchParams.get("industries")),
      lookingFor: url.searchParams.get("lookingFor") ?? undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    return Response.json({ matches });
  } catch (e) {
    if (e instanceof ConnectorError) return introErrorResponse(e);
    return httpErrorResponse(e);
  }
}
