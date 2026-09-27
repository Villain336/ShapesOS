// Marketr — studio designs API (Phase 11 "Canvas").
// GET  /api/studio/designs              — list designs for the workspace
// POST /api/studio/designs              — create a design from a template or blank size (editor)

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { getTemplate, TEMPLATES } from "@/lib/design/templates";
import { blankDocument, type DesignDocument } from "@/lib/design/types";
import { guardWorkspace, httpErrorResponse, readJson } from "./_lib";

export const dynamic = "force-dynamic";

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  width: z.number().int().min(100).max(4000).default(1080),
  height: z.number().int().min(100).max(4000).default(1080),
  templateKey: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .refine((k) => getTemplate(k) !== undefined, {
      message: `templateKey must be one of: ${TEMPLATES.map((t) => t.key).join(", ")}`,
    })
    .optional(),
  brandKitId: z.string().trim().min(1).max(64).optional(),
});

interface DesignRowLike {
  id: string;
  name: string;
  thumbnail: string | null;
  templateKey: string | null;
  document: unknown;
  updatedAt: Date;
}

/** Summarize a design row for the designs list (page/element counts). */
export function summarizeDesign(row: DesignRowLike) {
  let pageCount = 0;
  let elementCount = 0;
  const doc = row.document as { pages?: Array<{ elements?: unknown[] }> } | null;
  if (doc && Array.isArray(doc.pages)) {
    pageCount = doc.pages.length;
    for (const p of doc.pages) {
      if (Array.isArray(p.elements)) elementCount += p.elements.length;
    }
  }
  return {
    id: row.id,
    name: row.name,
    thumbnail: row.thumbnail,
    templateKey: row.templateKey,
    pageCount,
    elementCount,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const rows = await prisma.design.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { updatedAt: "desc" },
    });
    return Response.json({ designs: rows.map(summarizeDesign) });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const parsed = CreateSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
    }

    let document: DesignDocument;
    let templateKey: string | null = null;
    if (parsed.data.templateKey) {
      const template = getTemplate(parsed.data.templateKey);
      // safeParse's refine already guarantees existence; this is defense-in-depth.
      if (!template) {
        return Response.json({ error: "Unknown templateKey" }, { status: 400 });
      }
      document = template.build();
      templateKey = template.key;
    } else {
      document = blankDocument(parsed.data.width, parsed.data.height);
    }

    const created = await prisma.design.create({
      data: {
        workspaceId: workspace.id,
        name: parsed.data.name,
        document: document as unknown as Prisma.InputJsonValue,
        templateKey,
        brandKitId: parsed.data.brandKitId ?? null,
        createdBy: user.id,
      },
    });
    return Response.json(
      {
        design: {
          id: created.id,
          name: created.name,
          document: created.document,
          templateKey: created.templateKey,
          brandKitId: created.brandKitId,
          updatedAt: created.updatedAt.toISOString(),
        },
      },
      { status: 201 },
    );
  } catch (e) {
    return httpErrorResponse(e);
  }
}
