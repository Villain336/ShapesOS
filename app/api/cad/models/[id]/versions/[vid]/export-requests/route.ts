// Marketr — CAD + Hardware slice 3 API.
// GET  /api/cad/models/[id]/versions/[vid]/export-requests — list quote requests for a version.
// POST /api/cad/models/[id]/versions/[vid]/export-requests — draft a quote
//        request (editor; body: process, quantity, processOptions?, contact?).
//        Contact name/email pre-fill from the tenant workspace + session; the
//        tenant reviews them on the draft. v1 does not place orders.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaCadPipelineStore } from "@/lib/cad/pipeline-store";
import { CadError } from "@/lib/cad/types";

export const dynamic = "force-dynamic";

function cadErrorResponse(e: CadError) {
  const notFound = ["VERSION_NOT_FOUND"];
  return Response.json(
    { error: e.message, code: e.code },
    { status: notFound.includes(e.code) ? 404 : 400 },
  );
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; vid: string }> },
) {
  try {
    const { id, vid } = await params;
    const { workspace } = await guardWorkspace();
    const store = new PrismaCadPipelineStore(prisma);
    // List is scoped to the model; the version param narrows to one version's
    // requests client-side.
    const all = await store.listExportRequests(workspace.id, id);
    return Response.json({ requests: all.filter((r) => r.modelVersionId === vid) });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; vid: string }> },
) {
  try {
    const { vid } = await params;
    const { user, workspace } = await guardWorkspace({ editor: true });
    const body = await req.json();
    const contactIn = (body?.contact ?? {}) as Record<string, unknown>;
    const store = new PrismaCadPipelineStore(prisma);
    const request = await store.createExportRequest(workspace.id, user.email ?? user.id, vid, {
      process: body?.process ?? "",
      quantity: body?.quantity,
      processOptions: body?.processOptions,
      // Tenant-profile pre-fill: workspace name + session email; the tenant
      // reviews and can change them on the draft before confirming.
      contact: {
        name: contactIn.name ?? workspace.name,
        email: contactIn.email ?? user.email,
        addressLines: contactIn.addressLines,
      },
    });
    return Response.json({ request }, { status: 201 });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}
