// Marketr — CAD + Hardware slice 2 API.
// GET  /api/cad/models/[id]/annotations — annotations (viewer+; ?versionId= filters).
// POST /api/cad/models/[id]/annotations — create (editor).

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaCadAiStore } from "@/lib/cad/ai-store";
import { CadError } from "@/lib/cad/types";

export const dynamic = "force-dynamic";

function cadErrorResponse(e: CadError) {
  const notFound = [
    "PROJECT_NOT_FOUND",
    "MODEL_NOT_FOUND",
    "VERSION_NOT_FOUND",
    "ANNOTATION_NOT_FOUND",
  ];
  const forbidden = ["AGENT_CANNOT_ACT"];
  const status = notFound.includes(e.code)
    ? 404
    : forbidden.includes(e.code)
      ? 403
      : 400;
  return Response.json({ error: e.message, code: e.code }, { status });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { workspace } = await guardWorkspace();
    const store = new PrismaCadAiStore(prisma);
    const url = new URL(req.url);
    const annotations = await store.listAnnotations(
      workspace.id,
      id,
      url.searchParams.get("versionId") ?? undefined,
    );
    return Response.json({ annotations });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { user, workspace } = await guardWorkspace({ editor: true });
    const body = await req.json();
    const store = new PrismaCadAiStore(prisma);
    const anchorKind = body?.anchor ?? "whole";
    const anchor =
      anchorKind === "point"
        ? { kind: "point" as const, point: body?.point }
        : anchorKind === "region"
          ? { kind: "region" as const, region: body?.region }
          : { kind: "whole" as const };
    const annotation = await store.createAnnotation(
      workspace.id,
      user.email ?? user.id,
      id,
      body?.versionId ?? "",
      body?.body ?? "",
      anchor,
    );
    return Response.json({ annotation }, { status: 201 });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}
