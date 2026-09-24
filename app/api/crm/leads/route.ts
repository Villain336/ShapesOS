// Marketr — CRM leads collection.
// GET  /api/crm/leads?pipelineId=&stage=&owner=&source=&scoreBand=&activeWithinDays=&q=&limit=&cursor=
// POST /api/crm/leads  → create (editor+); dedup-checked (409 + existing lead)

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { dedupKeyFor, recomputeScore, logActivity } from "@/lib/crm/dedup";
import { parseStages, CLOSED_STAGES } from "@/lib/crm/stages";

const SOURCES = ["website_form", "phone", "referral", "import", "ad", "ooh", "direct_mail", "other"] as const;

const CreateSchema = z.object({
  pipelineId: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(160),
  email: z.string().trim().max(254).optional(),
  phone: z.string().trim().max(40).optional(),
  company: z.string().trim().max(160).optional(),
  title: z.string().trim().max(160).optional(),
  source: z.enum(SOURCES).default("other"),
  sourceDetail: z.string().trim().max(240).optional(),
  stage: z.string().trim().min(1).max(40).optional(),
  valueCents: z.number().int().min(0).max(1_000_000_000).optional(),
  ownerId: z.string().max(128).optional(),
  ownerName: z.string().trim().max(160).optional(),
  projectId: z.string().max(64).optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
});

function validEmail(e: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);

  const sp = new URL(req.url).searchParams;
  const where: Prisma.LeadWhereInput = { workspaceId: workspace.id };
  const pipelineId = sp.get("pipelineId");
  if (pipelineId) where.pipelineId = pipelineId;
  const stage = sp.get("stage");
  if (stage) where.stage = stage;
  const owner = sp.get("owner");
  if (owner) where.OR = [{ ownerId: owner }, { ownerName: owner }];
  const source = sp.get("source");
  if (source) where.source = source as (typeof SOURCES)[number];
  const band = sp.get("scoreBand");
  if (band === "hot") where.score = { gte: 70 };
  else if (band === "warm") where.score = { gte: 40, lt: 70 };
  else if (band === "cold") where.score = { lt: 40 };
  const activeWithin = Number(sp.get("activeWithinDays") ?? "");
  if (Number.isFinite(activeWithin) && activeWithin > 0) {
    where.lastActivityAt = { gte: new Date(Date.now() - activeWithin * 86_400_000) };
  }
  const starred = sp.get("starred");
  if (starred === "true") where.starred = true;
  const q = sp.get("q")?.trim();
  if (q) {
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : []),
      {
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
          { company: { contains: q, mode: "insensitive" } },
          { phone: { contains: q } },
        ],
      },
    ];
  }

  const limit = Math.min(200, Math.max(1, Number(sp.get("limit") ?? "50") || 50));
  const cursor = sp.get("cursor") ?? undefined;
  const sort = sp.get("sort") ?? "recent";
  const orderBy =
    sort === "score" ? { score: "desc" as const }
    : sort === "value" ? { valueCents: "desc" as const }
    : { lastActivityAt: "desc" as const };

  const leads = await prisma.lead.findMany({
    where,
    orderBy,
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: {
      pipeline: { select: { id: true, name: true } },
      _count: { select: { activities: true } },
    },
  });
  const hasMore = leads.length > limit;
  const page = hasMore ? leads.slice(0, limit) : leads;

  // Optional activity trend: 8 weekly buckets per lead (sparkline column).
  let trends: Record<string, number[]> = {};
  if (sp.get("trend") === "1" && page.length > 0) {
    const since = new Date(Date.now() - 8 * 7 * 86_400_000);
    const acts = await prisma.leadActivity.findMany({
      where: { workspaceId: workspace.id, leadId: { in: page.map((l) => l.id) }, createdAt: { gte: since } },
      select: { leadId: true, createdAt: true },
    });
    const buckets: Record<string, number[]> = {};
    for (const a of acts) {
      const w = Math.min(7, Math.floor((Date.now() - a.createdAt.getTime()) / (7 * 86_400_000)));
      buckets[a.leadId] ??= new Array(8).fill(0);
      buckets[a.leadId][7 - w] += 1;
    }
    for (const l of page) trends[l.id] = buckets[l.id] ?? new Array(8).fill(0);
  }

  // Status-bar aggregates over the filtered set (bounded: computed on the
  // same where clause, not the page).
  const [inView, agg] = await prisma.$transaction([
    prisma.lead.count({ where }),
    prisma.lead.aggregate({
      where,
      _sum: { valueCents: true },
      _avg: { score: true },
    }),
  ]);

  return Response.json({
    leads: page,
    nextCursor: hasMore ? page[page.length - 1].id : null,
    trends,
    summary: {
      inView,
      pipelineCents: agg._sum.valueCents ?? 0,
      avgScore: agg._avg.score == null ? 0 : Math.round(agg._avg.score),
    },
  });
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();

  let body: unknown;
  try { body = await req.json(); } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
  }
  const d = parsed.data;

  const pipeline = await prisma.pipeline.findFirst({
    where: { id: d.pipelineId, workspaceId: workspace.id },
  });
  if (!pipeline) return Response.json({ error: "Pipeline not found" }, { status: 404 });

  if (d.email && !validEmail(d.email)) {
    return Response.json({ error: "Invalid email" }, { status: 400 });
  }
  if (d.projectId) {
    const project = await prisma.project.findFirst({
      where: { id: d.projectId, workspaceId: workspace.id },
    });
    if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  }

  const stages = parseStages(pipeline.stages);
  const stage = d.stage ?? stages[0].id;
  if (!stages.some((s) => s.id === stage)) {
    return Response.json({ error: `Unknown stage "${stage}" for this pipeline` }, { status: 400 });
  }

  const dedupKey = dedupKeyFor(d.email, d.phone);
  // Fast path: check-then-insert. The UNIQUE(workspaceId, dedupKey) constraint
  // below is the race backstop (P2002 → 409).
  if (dedupKey) {
    const existing = await prisma.lead.findFirst({
      where: { workspaceId: workspace.id, dedupKey, NOT: { stage: { in: [...CLOSED_STAGES] } } },
      select: { id: true, name: true, email: true, company: true, stage: true },
    });
    if (existing) {
      return Response.json(
        { error: "Duplicate lead", duplicate: true, existing },
        { status: 409 },
      );
    }
  }

  let lead;
  try {
    lead = await prisma.lead.create({
      data: {
        workspaceId: workspace.id,
        pipelineId: pipeline.id,
        projectId: d.projectId ?? null,
        name: d.name,
        email: d.email?.trim() || null,
        phone: d.phone?.trim() || null,
        company: d.company?.trim() || null,
        title: d.title?.trim() || null,
        source: d.source,
        sourceDetail: d.sourceDetail?.trim() || null,
        stage,
        valueCents: d.valueCents ?? null,
        ownerId: d.ownerId ?? null,
        ownerName: d.ownerName?.trim() || null,
        customFields: (d.customFields ?? undefined) as unknown as Prisma.InputJsonValue | undefined,
        dedupKey,
      },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002" && dedupKey) {
      const existing = await prisma.lead.findFirst({
        where: { workspaceId: workspace.id, dedupKey },
        select: { id: true, name: true, email: true, company: true, stage: true },
      });
      return Response.json(
        { error: "Duplicate lead", duplicate: true, existing },
        { status: 409 },
      );
    }
    throw e;
  }

  await logActivity({
    workspaceId: workspace.id,
    leadId: lead.id,
    type: "created",
    body: `Lead created (${d.source})`,
    actor: user.name ?? user.email ?? "User",
  });
  await recomputeScore(lead.id, workspace.id);

  const full = await prisma.lead.findUnique({ where: { id: lead.id } });
  return Response.json({ lead: full }, { status: 201 });
}
