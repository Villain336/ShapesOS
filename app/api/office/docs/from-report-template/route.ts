// Marketr — Phase 14 slice 8: report template → editable Univer doc.
// POST /api/office/docs/from-report-template { templateId }
// Converts the template's tiptap content into a doc snapshot (conservative
// mapping) and stores it as a host-owned UniverDoc. The client deliverable
// can then be edited in the embedded editor and exported via the in-house
// PDF writer.

import { z } from "zod";
import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { createUniverDoc } from "@/lib/univer/docs";
import { tiptapToDocSnapshot } from "@/lib/univer/tiptap";

export const dynamic = "force-dynamic";

const BodySchema = z.object({ templateId: z.string().min(1) });

export async function POST(req: Request) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const body = BodySchema.parse(await readJson(req));

    const template = await prisma.reportTemplate.findFirst({
      where: { id: body.templateId, workspaceId: workspace.id },
      select: { id: true, name: true, content: true },
    });
    if (!template) return Response.json({ error: "not found" }, { status: 404 });

    const snapshot = tiptapToDocSnapshot(template.content, template.name);
    const doc = await createUniverDoc(workspace.id, {
      kind: "doc",
      title: `${template.name} (doc)`,
      snapshot,
      sourceRef: `report-template:${template.id}`,
    });
    return Response.json({ doc: { id: doc.id } }, { status: 201 });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
