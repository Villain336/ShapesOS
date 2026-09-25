// Marketr — POST /api/flywheel/ctv/ios
//
// Concierge IO workflow: generate the IO document + creative brief for
// MNTN/Roku/Tatari/tvScientific. States draft → pending_vendor_approval
// → human_placed → live → reconciling. Transition endpoint:
//   POST /api/flywheel/ctv/ios { action: "transition", ioId, to, ... }
// Creation: { action: "create", ...ioFields }
// Honesty notes are embedded in every generated IO.

import type { NextRequest } from "next/server";
import { z } from "zod";
import { ctvGuard, badRequest, safetyError, readJson } from "../_lib";
import { resolveCtvStore, type CtvIoState } from "@/lib/flywheel/ctv/store";
import {
  generateIo,
  transitionIo,
  vendorNote,
  CONCIERGE_VENDORS,
  CONCIERGE_ALERT_ONLY_COPY,
} from "@/lib/flywheel/ctv/concierge";

export const dynamic = "force-dynamic";

const CreateIoSchema = z.object({
  action: z.literal("create"),
  campaignId: z.string().trim().min(1).max(64),
  vendor: z.enum(CONCIERGE_VENDORS),
  advertiserName: z.string().trim().min(1).max(160),
  audience: z.string().trim().min(1).max(500),
  geo: z.array(z.string().trim().min(1).max(64)).min(1).max(60),
  budgetCents: z.number().int().positive().max(100_000_000_00),
  flightStart: z.string().trim().min(1),
  flightEnd: z.string().trim().min(1),
  approvalObjectId: z.string().trim().min(1).max(64),
  spotCount: z.number().int().positive().max(1000),
});

const TransitionIoSchema = z.object({
  action: z.literal("transition"),
  ioId: z.string().trim().min(1).max(64),
  to: z.enum(["pending_vendor_approval", "human_placed", "live", "reconciling", "cancelled"]),
  placedBy: z.string().trim().max(128).optional(),
  vendorConfirmation: z.string().trim().max(256).optional(),
});

export async function POST(req: NextRequest) {
  const gate = await ctvGuard("editor");
  if (gate instanceof Response) return gate;
  const body = await readJson(req);
  const action = body.action;

  try {
    const store = await resolveCtvStore();

    if (action === "create") {
      const parsed = CreateIoSchema.safeParse(body);
      if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);
      const d = parsed.data;
      const campaign = await store.getCampaign(gate.workspaceId, d.campaignId);
      if (!campaign) return safetyError(new Error("CTV campaign not found in workspace"));
      if (campaign.mode !== "concierge") {
        return badRequest("IO generation is for concierge campaigns (use the Vibe adapter for API buys).");
      }
      const validations = await store.listValidations(gate.workspaceId);
      const passing = validations.find((v) => v.pass && v.campaignId === d.campaignId);
      if (!passing) {
        return safetyError(new Error("IO generation BLOCKED: no passing creative validation for this campaign."));
      }
      const { ioDocument, creativeBrief } = generateIo({
        workspaceId: gate.workspaceId,
        campaignId: d.campaignId,
        vendor: d.vendor,
        advertiserName: d.advertiserName,
        audience: d.audience,
        geo: d.geo,
        budgetCents: d.budgetCents,
        flightStart: d.flightStart,
        flightEnd: d.flightEnd,
        validation: {
          pass: passing.pass, checks: passing.checks,
          durationSeconds: passing.durationSeconds,
          publisherRulesVersion: passing.publisherRulesVersion,
          probe: passing.ffprobeJson,
        },
        approvalObjectId: d.approvalObjectId,
        spotCount: d.spotCount,
      });
      const io = await store.createIo({
        workspaceId: gate.workspaceId,
        campaignId: d.campaignId,
        vendor: d.vendor,
        ioPayload: { ioDocument, creativeBrief },
        state: "draft",
        placedBy: null,
        placedAt: null,
        vendorConfirmation: null,
      });
      await store.audit({
        workspaceId: gate.workspaceId, actor: gate.userId, action: "io_created",
        subjectType: "io", subjectId: io.id,
        detail: { vendor: d.vendor, budgetCents: d.budgetCents, approvalObjectId: d.approvalObjectId },
      });
      return Response.json({
        io,
        alertOnlyCopy: CONCIERGE_ALERT_ONLY_COPY,
        vendorNote: vendorNote(d.vendor),
      });
    }

    if (action === "transition") {
      const parsed = TransitionIoSchema.safeParse(body);
      if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);
      const d = parsed.data;
      const io = await transitionIo(store, gate.workspaceId, d.ioId, d.to as CtvIoState, gate.userId, {
        placedBy: d.placedBy,
        vendorConfirmation: d.vendorConfirmation,
      });
      if (d.to === "human_placed") {
        await store.updateCampaign(gate.workspaceId, io.campaignId, { status: "human_placed" });
      }
      if (d.to === "live") {
        await store.updateCampaign(gate.workspaceId, io.campaignId, { status: "live" });
      }
      return Response.json({ io, alertOnlyCopy: CONCIERGE_ALERT_ONLY_COPY });
    }

    return badRequest('action must be "create" or "transition"');
  } catch (err) {
    return safetyError(err);
  }
}
