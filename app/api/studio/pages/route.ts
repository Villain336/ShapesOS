// Marketr — studio pages API (Phase 12, GrapesJS page drafts).
// GET  /api/studio/pages              — list page drafts for the workspace
// POST /api/studio/pages              — create a draft { name, kind, templateKey? }

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { guardWorkspace, httpErrorResponse, readJson } from "../designs/_lib";
import { getGrapesTemplate } from "@/lib/grapes/templates";

export const dynamic = "force-dynamic";

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["landing", "email"]).default("landing"),
  templateKey: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .refine((k) => getGrapesTemplate(k) !== undefined, { message: "Unknown template key." })
    .optional(),
});

export function summarizePage(row: {
  id: string;
  name: string;
  kind: string;
  templateKey: string | null;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    templateKey: row.templateKey,
    templateName: row.templateKey ? getGrapesTemplate(row.templateKey)?.name ?? null : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const rows = await prisma.pageDraft.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { updatedAt: "desc" },
      select: { id: true, name: true, kind: true, templateKey: true, updatedAt: true },
    });
    return NextResponse.json({ pages: rows.map(summarizePage) });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const body = CreateSchema.parse(await readJson(req));
    const page = await prisma.pageDraft.create({
      data: {
        workspaceId: workspace.id,
        name: body.name,
        kind: body.kind,
        templateKey: body.templateKey ?? null,
        createdBy: user.id,
      },
      select: { id: true, name: true, kind: true, templateKey: true, updatedAt: true },
    });
    return NextResponse.json({ page: summarizePage(page) }, { status: 201 });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
