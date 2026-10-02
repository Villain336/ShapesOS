// Marketr — CAD + Hardware slice 4 API.
// POST /api/cad/tasks/[id]/pin — pin the task to a specific immutable model
//        revision (editor). Body: { modelVersionId }. The version must belong
//        to the task's project; the pin is a reference — the version row is
//        never mutated.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaCadProjectStore } from "@/lib/cad/project-store";
import { CadError } from "@/lib/cad/types";

export const dynamic = "force-dynamic";

function cadErrorResponse(e: CadError) {
  const notFound = ["TASK_NOT_FOUND", "VERSION_NOT_FOUND"];
  return Response.json(
    { error: e.message, code: e.code },
    { status: notFound.includes(e.code) ? 404 : 400 },
  );
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { user, workspace } = await guardWorkspace({ editor: true });
    const body = await req.json();
    const store = new PrismaCadProjectStore(prisma);
    const task = await store.pinTaskVersion(
      workspace.id,
      user.email ?? user.id,
      id,
      String(body?.modelVersionId ?? ""),
    );
    return Response.json({ task });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}
