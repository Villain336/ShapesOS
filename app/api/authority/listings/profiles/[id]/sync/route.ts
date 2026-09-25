// Marketr — POST /api/authority/listings/profiles/:id/sync (editor)
//
// Queue a profile edit. Rules:
//  - Every edit requires an APPROVED listing_edit approval whose binding
//    matches this exact edit — verified here AND re-verified at execution.
//  - Burst edits QUEUE under the 10-edits/min/profile cap — never dropped.
//  - manual / guided_claim channels refuse sync outright (tier honesty:
//    Marketr never auto-submits those tiers).
//  - Bing sync requires production trusted-partner state.

import type { NextRequest } from "next/server";
import { authorityGuard, badRequest, safetyError } from "@/app/api/authority/_lib";
import { authorityTablesReady, authorityApprovals, authorityAudit } from "@/lib/authority/db";
import { verifyBinding } from "@/lib/authority/approvals";
import { createPrismaListingStore } from "@/lib/authority/listings/store";
import { validateGbpEdit, listingEditBinding, type GbpEditRequest } from "@/lib/authority/listings/gbp";
import { bingSyncAllowed, type BingApplicationRecord, type BingApplicationState } from "@/lib/authority/listings/bing";
import { channelTier } from "@/lib/authority/listings/tiers";
import { queueSyncSchema } from "@/app/api/authority/listings/_schemas";

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
  const parsed = queueSyncSchema.safeParse(raw);
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);

  try {
    const store = createPrismaListingStore();
    const profile = await store.profiles.get(id, gate.workspaceId);
    if (!profile) return Response.json({ error: "Profile not found in workspace." }, { status: 404 });

    const info = channelTier(profile.channel);
    // Tier honesty: manual and guided-claim tiers are never auto-synced.
    if (info.tier === "manual" || info.tier === "guided_claim") {
      return Response.json({
        error: `${info.displayName} is ${info.tierLabel.toLowerCase()} — Marketr never auto-submits this tier. ${info.capabilityNote}`,
        tier: info.tier, tierLabel: info.tierLabel,
      }, { status: 422 });
    }
    if (profile.channel === "bing") {
      const ch = await store.channels.get(gate.workspaceId, "bing");
      const app = (ch?.configJson?.bingApplication ?? null) as Partial<BingApplicationRecord> | null;
      const state = (app?.state ?? "not_started") as BingApplicationState;
      if (!bingSyncAllowed({ workspaceId: gate.workspaceId, state, appliedAt: null, sandboxAt: null, productionAt: null, notes: [], updatedAt: new Date() })) {
        return Response.json({
          error: "Bing bulk sync requires an approved production trusted-partner application (sandbox first). Application state is not production.",
          tier: info.tier, tierLabel: info.tierLabel,
        }, { status: 422 });
      }
    }
    if (profile.channel === "lde") {
      return Response.json({
        error: "Local Data Exchange is a flagged prototype — not a production sync path. Evaluate it via POST /api/authority/listings/lde/evaluate.",
        tier: info.tier, tierLabel: info.tierLabel,
      }, { status: 422 });
    }
    if (profile.channel !== "gbp") {
      return Response.json({ error: `Channel "${profile.channel}" has no sync path in v1.` }, { status: 422 });
    }

    const edit: GbpEditRequest = {
      profileId: profile.id,
      locationRef: parsed.data.locationRef ?? profile.locationRef,
      kind: parsed.data.kind,
      payload: parsed.data.payload,
    };
    validateGbpEdit(edit);

    // Approval-bound: the approval must exist, be approved, and bind to this exact edit.
    const approval = await authorityApprovals.get(parsed.data.approvalId, gate.workspaceId);
    if (!approval) return Response.json({ error: "listing_edit approval not found in workspace." }, { status: 404 });
    if (approval.type !== "listing_edit") {
      return Response.json({ error: `Approval ${approval.id} is type ${approval.type}, not listing_edit.` }, { status: 422 });
    }
    if (approval.status !== "approved") {
      return Response.json({ error: `Listing edit refused — approval is ${approval.status}, not approved. Every listing edit is approval-bound.` }, { status: 422 });
    }
    if (!verifyBinding(approval, listingEditBinding(edit))) {
      await authorityAudit.logAsync({
        workspaceId: gate.workspaceId, actor: gate.userId, action: "listing_sync_binding_mismatch",
        entityType: "listing_sync_job", entityId: approval.id,
        detail: { profileId: profile.id },
      }).catch(() => undefined);
      return Response.json({ error: "Binding mismatch — the approved binding does not match this edit. Sync refused." }, { status: 422 });
    }

    // Cap-aware enqueue: bursts queue with scheduled_at spacing, never drop.
    const job = await store.jobs.enqueue(gate.workspaceId, edit, approval.id);
    await authorityAudit.logAsync({
      workspaceId: gate.workspaceId, actor: gate.userId, action: "listing_sync_queued",
      entityType: "listing_sync_job", entityId: job.id,
      detail: { profileId: profile.id, kind: edit.kind, approvalId: approval.id, scheduledAt: job.scheduledAt.toISOString() },
    }).catch(() => undefined);

    return Response.json({
      job: { id: job.id, status: job.status, scheduledAt: job.scheduledAt, approvalId: job.approvalId },
      queued: true,
      note: "Queued under the 10-edits/min/profile cap. The binding is re-verified at execution; any mismatch halts the job.",
    });
  } catch (err) {
    return safetyError(err);
  }
}
