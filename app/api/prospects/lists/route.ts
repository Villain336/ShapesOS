// Marketr — R6 prospect lists API.
// GET  /api/prospects/lists → workspace lists with prospect/enriched counts
// POST /api/prospects/lists (editor) → create a list { name, icp }

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";

const IcpSchema = z.object({
  industries: z.array(z.string().max(80)).max(50).default([]),
  employeeRange: z.string().max(40).optional(),
  geo: z.string().max(120).optional(),
  techSignals: z.array(z.string().max(80)).max(50).default([]),
  titles: z.array(z.string().max(80)).max(50).default([]),
});

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  icp: IcpSchema.partial().default({}),
});

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const lists = await prisma.prospectList.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { updatedAt: "desc" },
      include: {
        _count: { select: { prospects: true } },
      },
    });
    const enrichedCounts = await prisma.prospect.groupBy({
      by: ["listId"],
      where: { workspaceId: workspace.id, status: "enriched" },
      _count: { id: true },
    });
    const enrichedByList = new Map(enrichedCounts.map((r) => [r.listId, r._count.id]));
    return Response.json({
      lists: lists.map((l) => ({
        id: l.id,
        name: l.name,
        icp: l.icp,
        status: l.status,
        prospectCount: l._count.prospects,
        enrichedCount: enrichedByList.get(l.id) ?? 0,
        createdAt: l.createdAt,
        updatedAt: l.updatedAt,
      })),
    });
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
    const list = await prisma.prospectList.create({
      data: {
        workspaceId: workspace.id,
        name: parsed.data.name,
        icp: {
          industries: parsed.data.icp.industries ?? [],
          employeeRange: parsed.data.icp.employeeRange ?? null,
          geo: parsed.data.icp.geo ?? null,
          techSignals: parsed.data.icp.techSignals ?? [],
          titles: parsed.data.icp.titles ?? [],
        },
        status: "draft",
        createdBy: user.id,
      },
    });
    return Response.json({ list }, { status: 201 });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
