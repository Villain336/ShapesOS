// Marketr — R6 → CRM conversion (lib/enrichment/crm-sync.ts).
//
// convertToLead() moves an enriched prospect into the Lead Pipeline CRM.
// This is the CLOSED LOOP: the lead carries source="prospecting" (see note
// below) + sourceDetail="<list name>", so C2 attribution can tie revenue
// back to the originating prospect list.
//
// SCHEMA NOTE (coordinator): "prospecting" is not yet a member of the
// LeadSource enum in prisma/schema.prisma. Until it is added, conversion
// uses source "import" with sourceDetail "Prospecting list: <name>" — the
// sourceDetail is what C2 attribution keys on, so the loop closes today.
// Flip PROSPECTING_SOURCE below the moment the enum lands; nothing else
// changes.

import { prisma } from "@/lib/prisma";
import { auditEvent } from "@/lib/auditlog";
import { dedupKeyFor, logActivity } from "@/lib/crm/dedup";
import { createLeadRecord, type LeadSource } from "@/lib/crm/leads";
import type { FileChangeAction } from "@prisma/client";
import type { Lead } from "@prisma/client";
import { ConflictError, NotFoundError } from "@/lib/api/errors";

// TODO(schema): change to "prospecting" once LeadSource gains the member.
const PROSPECTING_SOURCE: LeadSource = "import";

/** Enrichment score bonus applied on conversion (added to the CRM's computed score). */
export const CONVERSION_SCORE_BONUS = 15;

export interface ConvertResult {
  lead: Lead;
  /** True when the prospect matched an existing lead and was linked to it. */
  linkedExisting: boolean;
}

/**
 * Convert a prospect into a CRM lead.
 *
 * - Dedupes via the same email:/phone: dedupKey scheme as the CRM. When an
 *   open lead already exists for the identity, the prospect is linked to it
 *   (no duplicate lead) and still marked converted.
 * - Creates the lead with sourceDetail "Prospecting list: <name>" so C2 can
 *   attribute revenue back to the list.
 * - Logs "Enriched via <provider>" and "Converted from prospect list <name>"
 *   activities on the lead.
 * - Sets prospect.status = "converted" and prospect.leadId.
 */
export async function convertToLead(
  workspaceId: string,
  prospectId: string,
  pipelineId?: string,
  actorUserId?: string,
): Promise<ConvertResult> {
  const prospect = await prisma.prospect.findFirst({
    where: { id: prospectId, workspaceId },
    include: { list: { select: { name: true } } },
  });
  if (!prospect) throw new NotFoundError("Prospect not found");
  if (prospect.status === "converted" && prospect.leadId) {
    const existing = await prisma.lead.findFirst({
      where: { id: prospect.leadId, workspaceId },
    });
    if (existing) return { lead: existing, linkedExisting: true };
  }

  const pipeline =
    (pipelineId
      ? await prisma.pipeline.findFirst({ where: { id: pipelineId, workspaceId }, select: { id: true } })
      : null) ??
    (await prisma.pipeline.findFirst({
      where: { workspaceId },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    }));
  if (!pipeline) throw new ConflictError("No pipeline found in workspace — create a pipeline before converting prospects.");

  const listName = prospect.list.name;
  const sourceDetail = `Prospecting list: ${listName}`;
  const actor = actorUserId ?? "prospecting";
  const enrichment = (prospect.enrichmentData ?? {}) as Record<string, unknown>;
  const hitProvider =
    (enrichment.lastHitProvider as string | undefined) ??
    ((enrichment.providers as string[] | undefined)?.[0] ?? "unknown");

  // Dedup check-then-insert (same scheme as lib/crm/leads.ts).
  const dedupKey = dedupKeyFor(prospect.email, prospect.phone);
  if (dedupKey) {
    const dupe = await prisma.lead.findFirst({
      where: { workspaceId, dedupKey, NOT: { stage: { in: ["won", "lost"] } } },
      select: { id: true },
    });
    if (dupe) {
      const lead = (await prisma.lead.findUnique({ where: { id: dupe.id } }))!;
      await logActivity({
        workspaceId,
        leadId: lead.id,
        type: "note",
        body: `Converted from prospect list "${listName}" (matched existing lead — no duplicate created)`,
        actor,
      });
      await prisma.prospect.update({
        where: { id: prospect.id },
        data: { status: "converted", leadId: lead.id },
      });
      await auditEvent({
        projectId: null,
        workspaceId,
        action: "prospect_converted" as FileChangeAction,
        summary: `Prospect ${prospect.id} linked to existing lead ${lead.id} (dedup ${dedupKey})`,
        actorUserId,
      }).catch(() => {});
      return { lead, linkedExisting: true };
    }
  }

  const created = await createLeadRecord(workspaceId, actor, {
    pipelineId: pipeline.id,
    name: prospect.name?.trim() || prospect.company?.trim() || prospect.email?.trim() || "Unnamed prospect",
    email: prospect.email ?? undefined,
    phone: prospect.phone ?? undefined,
    company: prospect.company ?? undefined,
    title: prospect.title ?? undefined,
    source: PROSPECTING_SOURCE,
    sourceDetail,
    customFields: {
      prospectId: prospect.id,
      prospectListId: prospect.listId,
      enrichmentProvider: hitProvider,
      prospectScore: prospect.score,
    } as Record<string, unknown>,
  });
  if (!created.ok) {
    throw new Error(`Lead creation failed: ${created.error}`);
  }

  const lead = created.lead;
  const boostedScore = Math.min(100, lead.score + CONVERSION_SCORE_BONUS);
  await prisma.lead.update({ where: { id: lead.id }, data: { score: boostedScore } });

  await logActivity({
    workspaceId,
    leadId: lead.id,
    type: "note",
    body: `Enriched via ${hitProvider} (prospect score ${prospect.score})`,
    actor,
  });
  await logActivity({
    workspaceId,
    leadId: lead.id,
    type: "note",
    body: `Converted from prospect list "${listName}" (+${CONVERSION_SCORE_BONUS} enrichment score bonus)`,
    actor,
  });

  await prisma.prospect.update({
    where: { id: prospect.id },
    data: { status: "converted", leadId: lead.id },
  });

  // NOTE: "prospect_converted" must be added to the FileChangeAction enum in
  // prisma/schema.prisma by the schema coordinator — until then this no-ops.
  await auditEvent({
    projectId: null,
    workspaceId,
    action: "prospect_converted" as FileChangeAction,
    summary: `Prospect ${prospect.id} converted to lead ${lead.id} from list "${listName}"`,
    actorUserId,
  }).catch(() => {});

  const full = (await prisma.lead.findUnique({ where: { id: lead.id } })) ?? lead;
  return { lead: full, linkedExisting: false };
}
