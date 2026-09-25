// Marketr — POST /api/authority/listings/briefs/:id/verify-sweep (editor)
//
// Verification sweep: compare live snapshots against the pre-filled NAP
// payloads and detect NAP drift per directory/field. Directories submitted
// with no drift are marked verified; the brief's checklist status derives
// from the entries.

import type { NextRequest } from "next/server";
import { authorityGuard, badRequest, safetyError } from "@/app/api/authority/_lib";
import { authorityTablesReady, authorityAudit } from "@/lib/authority/db";
import { createPrismaListingStore } from "@/lib/authority/listings/store";
import { verifySweep, markDirectoryVerified, briefChecklistStatus } from "@/lib/authority/listings/briefs";
import { verifySweepSchema } from "@/app/api/authority/listings/_schemas";

export const dynamic = "force-dynamic";

interface RouteParams { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, { params }: RouteParams) {
  const gate = await authorityGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady())) {
    return Response.json({ error: "Authority tables not provisioned yet." }, { status: 503 });
  }
  const { id } = await params;
  let raw: unknown;
  try { raw = await req.json(); } catch { return badRequest("Invalid JSON"); }
  const parsed = verifySweepSchema.safeParse(raw);
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);

  try {
    const store = createPrismaListingStore();
    const brief = await store.briefs.get(id, gate.workspaceId);
    if (!brief) return Response.json({ error: "Citation brief not found in workspace." }, { status: 404 });

    const sweep = verifySweep(brief.directoriesJson, parsed.data.liveSnapshots);

    // Directories that were submitted and show no drift are verified by the sweep.
    const drifted = new Set(sweep.drift.map((d) => d.directory));
    let entries = brief.directoriesJson;
    for (const dir of sweep.clean) {
      if (!drifted.has(dir)) entries = markDirectoryVerified(entries, dir);
    }
    const checklistStatus = briefChecklistStatus(entries);
    const updated = await store.briefs.update(id, gate.workspaceId, { directoriesJson: entries, checklistStatus });

    await authorityAudit.logAsync({
      workspaceId: gate.workspaceId, actor: gate.userId, action: "citation_brief_verify_sweep",
      entityType: "citation_brief", entityId: id,
      detail: { directoriesChecked: sweep.directoriesChecked, driftCount: sweep.drift.length, cleanCount: sweep.clean.length, sweptAt: sweep.sweptAt },
    }).catch(() => undefined);

    return Response.json({
      sweep,
      checklistStatus: updated.checklistStatus,
      directories: updated.directoriesJson,
    });
  } catch (err) {
    return safetyError(err);
  }
}
