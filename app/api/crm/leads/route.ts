// Marketr — CRM leads collection.
// GET  /api/crm/leads?pipelineId=&stage=&owner=&source=&scoreBand=&activeWithinDays=&q=&limit=&cursor=
// POST /api/crm/leads  → create (editor+); dedup-checked (409 + existing lead)

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { createLeadRecord, LEAD_SOURCES, UtmSchema } from "@/lib/crm/leads";
import { applyPromoCodeToLead } from "@/lib/physical/bundles";
import { triggerSpeedToLead } from "@/lib/messaging/speed-to-lead";
import { intQuery, parseQuery } from "@/lib/api/validate";

const CreateSchema = z.object({
  pipelineId: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(160),
  email: z.string().trim().max(254).optional(),
  phone: z.string().trim().max(40).optional(),
  company: z.string().trim().max(160).optional(),
  title: z.string().trim().max(160).optional(),
  source: z.enum(LEAD_SOURCES).default("other"),
  sourceDetail: z.string().trim().max(240).optional(),
  stage: z.string().trim().min(1).max(40).optional(),
  valueCents: z.number().int().min(0).max(1_000_000_000).optional(),
  ownerId: z.string().max(128).optional(),
  ownerName: z.string().trim().max(160).optional(),
  projectId: z.string().max(64).optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
  // C2: optional UTM capture + linked content page for attribution touches.
  utm: UtmSchema.optional(),
  contentId: z.string().trim().max(64).optional(),
  // P2: optional promo code (WAVE-XXXXXX) — logs a promo_code touch.
  promoCode: z.string().trim().max(32).optional(),
});

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
  if (source) where.source = source as (typeof LEAD_SOURCES)[number];
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

  const limitQuery = parseQuery(z.object({ limit: intQuery(50, 1, 200) }), sp);
  if (!limitQuery.ok) return limitQuery.error;
  const limit = limitQuery.data.limit;
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

  // The create logic lives in lib/crm/leads.ts (shared with the batteries);
  // this route only handles auth, validation, and response mapping.
  const result = await createLeadRecord(workspace.id, user.name ?? user.email ?? "User", {
    pipelineId: d.pipelineId,
    name: d.name,
    email: d.email,
    phone: d.phone,
    company: d.company,
    title: d.title,
    source: d.source,
    sourceDetail: d.sourceDetail,
    stage: d.stage,
    valueCents: d.valueCents,
    ownerId: d.ownerId,
    ownerName: d.ownerName,
    projectId: d.projectId,
    customFields: d.customFields,
    utm: d.utm ?? null,
    contentId: d.contentId ?? null,
  });
  if (!result.ok) {
    return Response.json(
      { error: result.error, ...(result.existing ? { duplicate: true, existing: result.existing } : {}) },
      { status: result.status },
    );
  }
  // P2: promo code redemption — attaches the bundle's promo_code touch and
  // redemption row. A bad code never fails lead creation.
  let promoApplied: string | null = null;
  if (d.promoCode) {
    const bundle = await applyPromoCodeToLead(workspace.id, result.lead.id, d.promoCode);
    promoApplied = bundle?.campaignName ?? null;
  }
  // R3: best-effort speed-to-lead touch on the fastest consented channel.
  // Never breaks lead creation — consent-gated inside; failure is silent.
  try {
    await triggerSpeedToLead(workspace.id, result.lead.id);
  } catch {
    /* speed-to-lead is best-effort */
  }
  return Response.json({ lead: result.lead, promoApplied }, { status: 201 });
}
