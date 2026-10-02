// Marketr — Connector Agent slice 6 API.
// GET /api/connector/directory — the tenant's own directory profile (viewer role).
// PUT /api/connector/directory — publish / edit / unpublish the tenant's
//   directory profile (editor role). Opt-in only: discoverable defaults to
//   false and only an explicit `true` publishes. Unpublishing
//   (discoverable=false) hides the profile instantly — fully reversible.
//   { discoverable, name, role, company, bio, industries[], lookingFor,
//     shareNameRole, shareFull } — partial input merges with the current row.
import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaConnectorStore } from "@/lib/connector/prisma-store";
import { ConnectorError } from "@/lib/connector/types";
import { introErrorResponse } from "../intros/intro-error";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const store = new PrismaConnectorStore(prisma);
    const profile = await store.getDirectoryProfile(workspace.id);
    return Response.json({ profile });
  } catch (e) {
    if (e instanceof ConnectorError) return introErrorResponse(e);
    return httpErrorResponse(e);
  }
}

export async function PUT(req: Request) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as Record<string, unknown>;
    const store = new PrismaConnectorStore(prisma);
    const profile = await store.setDirectoryProfile(workspace.id, {
      discoverable: body.discoverable,
      name: body.name,
      role: body.role,
      company: body.company,
      bio: body.bio,
      industries: body.industries,
      lookingFor: body.lookingFor,
      shareNameRole: body.shareNameRole,
      shareFull: body.shareFull,
    });
    return Response.json({ profile });
  } catch (e) {
    if (e instanceof ConnectorError) return introErrorResponse(e);
    return httpErrorResponse(e);
  }
}
