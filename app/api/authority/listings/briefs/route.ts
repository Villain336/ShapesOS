// Marketr — POST /api/authority/listings/briefs (editor)
//
// The citation-brief product: competitor-gap analysis → pre-filled per-
// directory NAP payloads → tracked manual-submission checklist. Honest
// long-tail play: priced as done-for-you or DIY — never "automatic."
// Competitor data in v1 is fixtures, labeled as such.

import type { NextRequest } from "next/server";
import { authorityGuard, badRequest, safetyError } from "@/app/api/authority/_lib";
import { authorityTablesReady, authorityAudit } from "@/lib/authority/db";
import { createPrismaListingStore } from "@/lib/authority/listings/store";
import { competitorGap, buildChecklist, briefChecklistStatus } from "@/lib/authority/listings/briefs";
import { createBriefSchema } from "@/app/api/authority/listings/_schemas";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await authorityGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady())) {
    return Response.json({ error: "Authority tables not provisioned yet." }, { status: 503 });
  }
  let raw: unknown;
  try { raw = await req.json(); } catch { return badRequest("Invalid JSON"); }
  const parsed = createBriefSchema.safeParse(raw);
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);

  try {
    const gaps = competitorGap(parsed.data.clientDirectories);
    const entries = buildChecklist(gaps, parsed.data.canonicalNap);
    const store = createPrismaListingStore();
    const brief = await store.briefs.create({
      workspaceId: gate.workspaceId,
      competitorGapJson: {
        gaps,
        competitorsSource: "fixtures",
        note: "v1 competitor presence uses fixtures — replace with live discovery when available.",
      },
      directoriesJson: entries,
    });
    await store.briefs.update(gate.workspaceId, brief.id, { checklistStatus: briefChecklistStatus(entries) });

    await authorityAudit.logAsync({
      workspaceId: gate.workspaceId, actor: gate.userId, action: "citation_brief_created",
      entityType: "citation_brief", entityId: brief.id,
      detail: { directories: entries.length, highPriority: gaps.filter((g) => g.priority === "high").length },
    }).catch(() => undefined);

    return Response.json({
      brief: { id: brief.id, checklistStatus: briefChecklistStatus(entries), createdAt: brief.createdAt },
      gaps,
      directories: entries,
      honest: "Manual submission: ShapesOS pre-fills the NAP payloads and tracks completion — a human submits each directory.",
    });
  } catch (err) {
    return safetyError(err);
  }
}
