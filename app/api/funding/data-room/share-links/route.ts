// Marketr — Funding/VC slice 3 API.
// GET  /api/funding/data-room/share-links — the tenant's share links
//        (newest first; tokens included so the UI can render the URL once).
// POST /api/funding/data-room/share-links — create a link (editor).
//        Body: { docId?: string | null (null/omit = whole room),
//                docVersionId?: string | null (pinned version; null = current
//                at access time), expiresAt?: string | null (ISO, future),
//                viewerEmails?: string[] (allowlist; empty = open link) }.
//        The response carries the public URL path exactly once — the token
//        is never returned by any other endpoint.

import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaFundingStore } from "@/lib/funding/prisma-store";
import { FundingError } from "@/lib/funding/types";

export const dynamic = "force-dynamic";

function fundingErrorResponse(e: FundingError) {
  const notFound = ["DOC_NOT_FOUND", "LINK_NOT_FOUND", "VIEW_NOT_FOUND", "VERSION_NOT_FOUND"];
  return Response.json(
    { error: e.message, code: e.code },
    { status: notFound.includes(e.code) ? 404 : 400 },
  );
}

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const store = new PrismaFundingStore(prisma);
    const links = await store.listShareLinks(workspace.id);
    return Response.json({ workspaceId: workspace.id, links });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as {
      docId?: string | null;
      docVersionId?: string | null;
      expiresAt?: string | null;
      viewerEmails?: string[] | null;
    };
    const store = new PrismaFundingStore(prisma);
    const link = await store.createShareLink(workspace.id, {
      docId: body?.docId ?? null,
      docVersionId: body?.docVersionId ?? null,
      expiresAt: body?.expiresAt ?? null,
      viewerEmails: body?.viewerEmails ?? [],
    });
    return Response.json({ link }, { status: 201 });
  } catch (e) {
    if (e instanceof FundingError) return fundingErrorResponse(e);
    return httpErrorResponse(e);
  }
}
