// Marketr — GET/POST /api/media/dooh/plans/[id]/launch-packet (Phase 5 B1).
//
// GET: list compiled packets for the plan (viewer+).
// POST { approvalId }: compile the launch packet for an APPROVED buy
//   (editor+). Fail-closed: the approval must be approved/unexpired/
//   unrevoked, two-person provenance verified, binding hash intact, and the
//   plan must match the binding exactly — otherwise generation is blocked
//   and the buy stays "approved".

import type { NextRequest } from "next/server";
import { z } from "zod";
import { mediaGuard, badRequest } from "../../../../_lib";
import { prisma } from "@/lib/prisma";
import {
  compileLaunchPacket,
  type DoohPlanRecord,
  type PacketCreative,
  type PlacementTracking,
} from "@/lib/media/launch-packet";
import {
  SqlDoohPlanStore,
  SqlLaunchPacketStore,
  buyingTablesReady,
} from "@/lib/media/buying-store";
import { SqlApprovalStore } from "@/lib/media/db";
import { storageMode } from "@/lib/filesystem/storage";
import { appendBuyingEvent } from "@/lib/media/buying-store";

export const dynamic = "force-dynamic";

const CompileSchema = z.object({
  approvalId: z.string().min(1),
  /** Per-placement QR/pURL assignments from the attribution track. */
  tracking: z
    .array(
      z.object({
        placementRef: z.string().min(1),
        boardName: z.string().min(1),
        slug: z.string().min(1),
        destinationUrl: z.string().url(),
      }),
    )
    .default([]),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await mediaGuard("viewer");
  if (gate instanceof Response) return gate;
  const { id } = await params;
  if (!(await buyingTablesReady())) {
    return Response.json({ error: "Phase 5 buying tables are not yet migrated.", packets: [] }, { status: 503 });
  }
  const planStore = new SqlDoohPlanStore();
  const plan = await planStore.get(id, gate.workspaceId);
  if (!plan) return Response.json({ error: "Plan not found" }, { status: 404 });
  const packetStore = new SqlLaunchPacketStore();
  const packets = await packetStore.listForPlan(id, gate.workspaceId);
  // Deploy PR: no server filesystem path is exposed; the PDFs live in the
  // storage MARKETR_STORAGE selects (shared bucket on hosted installs).
  return Response.json({ packets, storage: storageMode() });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await mediaGuard("editor");
  if (gate instanceof Response) return gate;
  const { id } = await params;
  if (!(await buyingTablesReady())) {
    return Response.json({ error: "Phase 5 buying tables are not yet migrated." }, { status: 503 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest("Invalid JSON");
  }
  const parsed = CompileSchema.safeParse(raw);
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);

  const planStore = new SqlDoohPlanStore();
  const plan = await planStore.get(id, gate.workspaceId);
  if (!plan) return Response.json({ error: "Plan not found" }, { status: 404 });

  // The approval is the safety track's object — fetched via its store,
  // never reimplemented here.
  const approvalStore = new SqlApprovalStore();
  const approval = await approvalStore.get(parsed.data.approvalId, gate.workspaceId);
  if (!approval) return Response.json({ error: "Approval not found" }, { status: 404 });
  if (approval.workspaceId !== gate.workspaceId) {
    return Response.json({ error: "Cross-workspace approval rejected" }, { status: 403 });
  }

  // Creative detail rows for the packet (names/sizes alongside hashes).
  const creatives: PacketCreative[] = [];
  for (let i = 0; i < plan.creativeIds.length; i++) {
    const creativeId = plan.creativeIds[i];
    const row = await prisma.mailCreative.findFirst({
      where: { id: creativeId, workspaceId: gate.workspaceId },
      select: { id: true, name: true, size: true, version: true, creativeHash: true, pdfUrl: true },
    });
    creatives.push({
      id: creativeId,
      name: row?.name ?? creativeId,
      size: row?.size ?? "—",
      version: row?.version ?? 1,
      creativeHash: plan.creativeHashes[i] ?? row?.creativeHash ?? null,
      pdfUrl: row?.pdfUrl ?? null,
    });
  }

  const planRecord: DoohPlanRecord = {
    id: plan.id,
    workspaceId: plan.workspaceId,
    name: plan.name,
    vendor: plan.vendor,
    placementsJson: plan.placementsJson as DoohPlanRecord["placementsJson"],
    estimateJson: plan.estimateJson as DoohPlanRecord["estimateJson"],
    estimateCents: plan.estimateCents,
    currency: plan.currency,
    creativeIds: plan.creativeIds,
    creativeHashes: plan.creativeHashes,
    status: plan.status,
  };

  const tracking: PlacementTracking[] = parsed.data.tracking;

  const workspace = await prisma.workspace.findUnique({
    where: { id: gate.workspaceId },
    select: { name: true },
  });

  const packetStore = new SqlLaunchPacketStore();
  const version = await packetStore.nextVersion(plan.id, gate.workspaceId);

  let compiled;
  try {
    compiled = await compileLaunchPacket({
      workspaceId: gate.workspaceId,
      plan: planRecord,
      approval,
      creatives,
      tracking,
      generatedBy: gate.userId,
      origin: new URL(req.url).origin,
      workspaceName: workspace?.name ?? "ShapesOS",
      version,
    });
  } catch (e) {
    // Fail-closed: drift/stale/expired → 409, the buy stays "approved".
    const msg = e instanceof Error ? e.message : "Packet compilation failed";
    return Response.json({ error: msg }, { status: 409 });
  }

  const row = await packetStore.create({
    workspaceId: gate.workspaceId,
    planId: plan.id,
    approvalId: approval.id,
    bindingHash: approval.bindingHash,
    packetSha256: compiled.packetSha256,
    pdfUrl: "", // filled below
    version,
    generatedBy: gate.userId,
  });
  const pdfUrl = `/api/media/dooh/plans/${plan.id}/launch-packet/${row.id}/pdf`;
  await packetStore.setPdfUrl(row.id, gate.workspaceId, pdfUrl);
  await planStore.update(plan.id, gate.workspaceId, {
    launchPacketUrl: pdfUrl,
    status: "packet_ready",
  });

  // Buying-lifecycle audit (append-only): packet.compiled.
  await appendBuyingEvent({
    workspaceId: gate.workspaceId,
    actor: gate.userId,
    action: "packet.compiled",
    entityType: "launch_packet",
    entityId: row.id,
    payloadHash: compiled.packetSha256,
    detail: { planId: plan.id, approvalId: approval.id, version, maxSpendCents: approval.binding?.maxTotalSpendCents ?? null },
  });
  return Response.json(
    {
      packet: { ...row, pdfUrl },
      packetSha256: compiled.packetSha256,
      version,
    },
    { status: 201 },
  );
}
