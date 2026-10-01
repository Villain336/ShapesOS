// Marketr — Legal/Compliance slice 5 API.
// GET /api/legal/digital-properties/[id] — one property with its findings.
// PATCH /api/legal/digital-properties/[id] — rename / re-URL / notes (editor).
// DELETE /api/legal/digital-properties/[id] — remove property + findings (editor).
// Every response carries the information-not-advice label.

import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaLegalStore } from "@/lib/legal/prisma-store";
import { LEGAL_DISCLAIMER, LegalError } from "@/lib/legal/types";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await params;
    const store = new PrismaLegalStore(prisma);
    const property = await store.getDigitalProperty(workspace.id, id);
    if (!property) {
      return Response.json(
        { disclaimer: LEGAL_DISCLAIMER, error: `[UNKNOWN_PROPERTY] No digital property: ${id}` },
        { status: 404 },
      );
    }
    return Response.json({ disclaimer: LEGAL_DISCLAIMER, property });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const body = (await readJson(req)) as {
      name?: unknown;
      url?: unknown;
      notes?: unknown;
    };
    const store = new PrismaLegalStore(prisma);
    const property = await store.updateDigitalProperty(workspace.id, id, {
      name: typeof body.name === "string" ? body.name : undefined,
      url: typeof body.url === "string" || body.url === null ? body.url : undefined,
      notes: typeof body.notes === "string" || body.notes === null ? body.notes : undefined,
    });
    return Response.json({ disclaimer: LEGAL_DISCLAIMER, property });
  } catch (e) {
    if (e instanceof LegalError) {
      const status = e.code === "UNKNOWN_PROPERTY" ? 404 : 400;
      return Response.json(
        { disclaimer: LEGAL_DISCLAIMER, error: e.message },
        { status },
      );
    }
    return httpErrorResponse(e);
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const store = new PrismaLegalStore(prisma);
    await store.deleteDigitalProperty(workspace.id, id);
    return Response.json({ disclaimer: LEGAL_DISCLAIMER, deleted: id });
  } catch (e) {
    if (e instanceof LegalError) {
      const status = e.code === "UNKNOWN_PROPERTY" ? 404 : 400;
      return Response.json(
        { disclaimer: LEGAL_DISCLAIMER, error: e.message },
        { status },
      );
    }
    return httpErrorResponse(e);
  }
}
