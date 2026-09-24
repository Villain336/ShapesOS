// Marketr — CRM lead creation service.
//
// The exact create logic used by POST /api/crm/leads, extracted so the
// adversarial batteries (and future capture paths) exercise the same code
// the route runs: pipeline/stage validation, dedup check-then-insert with
// the P2002 race backstop, creation activity, score recompute, the creation
// attribution touch (C2), and the won-revenue event.

import { z } from "zod";
import { Prisma, type Lead } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { dedupKeyFor, recomputeScore, logActivity } from "./dedup";
import { parseStages, CLOSED_STAGES } from "./stages";
import { recordCaptureTouch, type UtmInput } from "@/lib/attribution/touches";
import { maybeRecordWonRevenue } from "@/lib/attribution/revenue";

export const LEAD_SOURCES = [
  "website_form",
  "phone",
  "referral",
  "import",
  "ad",
  "ooh",
  "direct_mail",
  "other",
] as const;

export type LeadSource = (typeof LEAD_SOURCES)[number];

/** UTM fields accepted on capture paths (also used by the CSV importer). */
export const UtmSchema = z.object({
  utm_source: z.string().trim().max(160).optional(),
  utm_medium: z.string().trim().max(80).optional(),
  utm_campaign: z.string().trim().max(160).optional(),
  utm_term: z.string().trim().max(160).optional(),
  utm_content: z.string().trim().max(160).optional(),
});

export interface CreateLeadInput {
  pipelineId: string;
  name: string;
  email?: string;
  phone?: string;
  company?: string;
  title?: string;
  source?: LeadSource;
  sourceDetail?: string;
  stage?: string;
  valueCents?: number;
  ownerId?: string;
  ownerName?: string;
  projectId?: string;
  customFields?: Record<string, unknown>;
  utm?: UtmInput | null;
  contentId?: string | null;
  /** Used as the touch campaign when no utm_campaign is present. */
  campaignFallback?: string | null;
}

export type CreateLeadResult =
  | { ok: true; lead: Lead }
  | {
      ok: false;
      status: 400 | 404 | 409;
      error: string;
      existing?: { id: string; name: string; email: string | null; company: string | null; stage: string } | null;
    };

export function validEmail(e: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

export async function createLeadRecord(
  workspaceId: string,
  actor: string,
  input: CreateLeadInput,
): Promise<CreateLeadResult> {
  const source: LeadSource = input.source ?? "other";

  const pipeline = await prisma.pipeline.findFirst({
    where: { id: input.pipelineId, workspaceId },
  });
  if (!pipeline) return { ok: false, status: 404, error: "Pipeline not found" };

  if (input.email && !validEmail(input.email)) {
    return { ok: false, status: 400, error: "Invalid email" };
  }
  if (input.projectId) {
    const project = await prisma.project.findFirst({
      where: { id: input.projectId, workspaceId },
    });
    if (!project) return { ok: false, status: 404, error: "Project not found" };
  }

  const stages = parseStages(pipeline.stages);
  const stage = input.stage ?? stages[0].id;
  if (!stages.some((s) => s.id === stage)) {
    return { ok: false, status: 400, error: `Unknown stage "${stage}" for this pipeline` };
  }

  const dedupKey = dedupKeyFor(input.email, input.phone);
  // Fast path: check-then-insert. The UNIQUE(workspaceId, dedupKey) constraint
  // below is the race backstop (P2002 → 409).
  if (dedupKey) {
    const existing = await prisma.lead.findFirst({
      where: { workspaceId, dedupKey, NOT: { stage: { in: [...CLOSED_STAGES] } } },
      select: { id: true, name: true, email: true, company: true, stage: true },
    });
    if (existing) {
      return { ok: false, status: 409, error: "Duplicate lead", existing };
    }
  }

  let lead: Lead;
  try {
    lead = await prisma.lead.create({
      data: {
        workspaceId,
        pipelineId: pipeline.id,
        projectId: input.projectId ?? null,
        name: input.name,
        email: input.email?.trim() || null,
        phone: input.phone?.trim() || null,
        company: input.company?.trim() || null,
        title: input.title?.trim() || null,
        source,
        sourceDetail: input.sourceDetail?.trim() || null,
        stage,
        valueCents: input.valueCents ?? null,
        ownerId: input.ownerId ?? null,
        ownerName: input.ownerName?.trim() || null,
        customFields: (input.customFields ?? undefined) as unknown as Prisma.InputJsonValue | undefined,
        dedupKey,
      },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002" && dedupKey) {
      const existing = await prisma.lead.findFirst({
        where: { workspaceId, dedupKey },
        select: { id: true, name: true, email: true, company: true, stage: true },
      });
      return { ok: false, status: 409, error: "Duplicate lead", existing };
    }
    throw e;
  }

  await logActivity({
    workspaceId,
    leadId: lead.id,
    type: "created",
    body: `Lead created (${source})`,
    actor,
  });

  // C2: the creation touch — every captured lead gets a `first` touch so
  // "leads by channel" is meaningful with or without UTMs.
  await recordCaptureTouch({
    workspaceId,
    leadId: lead.id,
    leadSource: source,
    utm: input.utm ?? null,
    contentId: input.contentId ?? null,
    campaignFallback: input.campaignFallback ?? null,
  });

  // C2: a lead created directly in won books revenue immediately.
  await maybeRecordWonRevenue({
    workspaceId,
    leadId: lead.id,
    before: { stage: "", valueCents: 0 },
    after: { stage: lead.stage, valueCents: lead.valueCents },
    actor,
  });

  await recomputeScore(lead.id, workspaceId);

  const full = await prisma.lead.findUnique({ where: { id: lead.id } });
  return { ok: true, lead: full ?? lead };
}
