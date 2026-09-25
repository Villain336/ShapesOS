// Marketr — POST /api/mail/campaigns/[id]/audience
//
// Build MailPieces from an audience source:
//   { kind: "crm_segment", ref: "{\"pipelineId\":\"…\",\"stage\":\"new\",\"minScore\":50}" }
//   { kind: "prospect_list", ref: "<prospectListId>" }
//   { kind: "csv", rows: [{ name, line1, line2?, city, state, zip, leadId? }] }
// ?dryRun=1 → preview only (no rows written).

import type { NextRequest } from "next/server";
import { z } from "zod";
import { mailGuard, badRequest } from "../../../_lib";
import { buildPieces, extractAddressFromLead, type AudienceSpec } from "@/lib/mail/service";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const RowSchema = z.object({
  name: z.string().trim().max(160).optional(),
  line1: z.string().trim().max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().max(120),
  state: z.string().trim().max(40),
  zip: z.string().trim().max(20),
  leadId: z.string().trim().min(1).optional(),
});

const AudienceSchema = z.object({
  kind: z.enum(["crm_segment", "prospect_list", "csv"]),
  ref: z.string().max(4000).optional(),
  rows: z.array(RowSchema).max(20000).optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await mailGuard("editor");
  if (gate instanceof Response) return gate;
  const { id } = await params;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest("Invalid JSON");
  }
  const parsed = AudienceSchema.safeParse(raw);
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);
  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";

  const audience: AudienceSpec = {
    kind: parsed.data.kind,
    ref: parsed.data.ref,
    rows: parsed.data.rows,
  };

  try {
    if (dryRun) {
      const preview = await previewAudience(gate.workspaceId, audience);
      return Response.json({ preview, dryRun: true });
    }
    const result = await buildPieces(gate.workspaceId, id, audience);
    return Response.json({ ...result, campaignId: id }, { status: 201 });
  } catch (e) {
    return badRequest(e instanceof Error ? e.message : "Audience build failed");
  }
}

/** Count what WOULD be built, without writing rows. */
async function previewAudience(workspaceId: string, audience: AudienceSpec) {
  if (audience.kind === "csv") {
    const rows = audience.rows ?? [];
    const usable = rows.filter((r) => r.line1 && r.city && r.state && r.zip).length;
    return { total: rows.length, usable, skippedNoAddress: rows.length - usable };
  }
  if (audience.kind === "prospect_list") {
    const listId = (audience.ref ?? "").trim();
    const prospects = await prisma.prospect.findMany({
      where: { listId, workspaceId },
      select: { leadId: true },
      take: 5000,
    });
    let usable = 0;
    for (const p of prospects) {
      if (!p.leadId) continue;
      const lead = await prisma.lead.findFirst({
        where: { id: p.leadId, workspaceId },
        select: { name: true, customFields: true },
      });
      if (lead && extractAddressFromLead(lead)) usable++;
    }
    return { total: prospects.length, usable, skippedNoAddress: prospects.length - usable };
  }
  let filter: Record<string, unknown> = {};
  try {
    filter = audience.ref ? (JSON.parse(audience.ref) as Record<string, unknown>) : {};
  } catch {
    throw new Error("crm_segment ref must be JSON");
  }
  const where: Record<string, unknown> = { workspaceId };
  if (filter.pipelineId) where.pipelineId = filter.pipelineId;
  if (filter.stage) where.stage = filter.stage;
  if (filter.source) where.source = filter.source;
  if (typeof filter.minScore === "number") where.score = { gte: filter.minScore };
  const leads = await prisma.lead.findMany({
    where,
    select: { name: true, customFields: true },
    take: 5000,
    orderBy: { createdAt: "asc" },
  });
  const usable = leads.filter((l) => extractAddressFromLead(l)).length;
  return { total: leads.length, usable, skippedNoAddress: leads.length - usable };
}
