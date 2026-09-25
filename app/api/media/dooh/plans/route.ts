// Marketr — GET/POST /api/media/dooh/plans (Phase 5 B1).
//
// GET: list plans (viewer+). With ?inventory=1: planning inventory lookup
//   via the vendor provider (fake default; vendor adapters are
//   planning/estimate-only).
// POST: create a DOOH plan (editor+). Computes the documented estimate via
//   the selected vendor provider and binds Studio creative ids + hashes.

import type { NextRequest } from "next/server";
import { z } from "zod";
import { createHash } from "node:crypto";
import { mediaGuard, badRequest } from "../../_lib";
import { prisma } from "@/lib/prisma";
import {
  getDoohProvider,
  DOOH_VENDOR_ORDER,
  DOOH_SIZE_SPECS,
  DOOH_DAYPARTS,
  ADQUICK_SELF_SERVE_URL,
  type DoohVendorName,
} from "@/lib/media/dooh";
import {
  SqlDoohPlanStore,
  appendBuyingEvent,
  buyingTablesReady,
} from "@/lib/media/buying-store";

export const dynamic = "force-dynamic";

const PlacementSchema = z.object({
  boardId: z.string().min(1),
  name: z.string().min(1),
  city: z.string().min(1),
  state: z.string().min(1),
  sizeId: z.string().optional(),
});

const CreatePlanSchema = z.object({
  name: z.string().trim().min(1).max(120),
  vendor: z.enum(["fake", "blip", "blindspot", "adomni"]),
  placements: z.array(PlacementSchema).min(1).max(50),
  dayparts: z.array(z.string()).min(1),
  flightStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  flightEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  playsPerBoardPerDay: z.number().int().min(1).max(100000).optional(),
  weeklyImpressions: z.number().int().min(0).optional(),
  creativeIds: z.array(z.string()).max(20).default([]),
});

const DAYPART_NAMES = new Set(DOOH_DAYPARTS.map((d) => d.name));

export async function GET(req: NextRequest) {
  const gate = await mediaGuard("viewer");
  if (gate instanceof Response) return gate;

  const url = new URL(req.url);
  if (url.searchParams.get("inventory") === "1") {
    // Planning inventory lookup (no spend, no availability guarantees).
    const vendor = (url.searchParams.get("vendor") || "fake") as DoohVendorName;
    const provider = getDoohProvider(vendor);
    const items = await provider.lookupInventory({
      city: url.searchParams.get("city") || undefined,
      state: url.searchParams.get("state") || undefined,
      limit: Math.min(Number(url.searchParams.get("limit") || 25), 100),
    });
    return Response.json({
      vendor,
      items,
      dayparts: DOOH_DAYPARTS,
      sizes: DOOH_SIZE_SPECS,
      vendorOrder: DOOH_VENDOR_ORDER,
      adquickReferral: ADQUICK_SELF_SERVE_URL,
      note: "Planning data only — availability and final pricing are confirmed in the client's own operator account. AdQuick API is parked; referral link to adquick.com self-serve only.",
    });
  }

  if (!(await buyingTablesReady())) {
    return Response.json(
      { error: "Phase 5 buying tables are not yet migrated.", plans: [] },
      { status: 503 },
    );
  }
  const store = new SqlDoohPlanStore();
  const plans = await store.list(gate.workspaceId);
  return Response.json({ plans });
}

export async function POST(req: NextRequest) {
  const gate = await mediaGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await buyingTablesReady())) {
    return Response.json({ error: "Phase 5 buying tables are not yet migrated." }, { status: 503 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest("Invalid JSON");
  }
  const parsed = CreatePlanSchema.safeParse(raw);
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);
  const body = parsed.data;

  const badDayparts = body.dayparts.filter((d) => !DAYPART_NAMES.has(d));
  if (badDayparts.length > 0) {
    return badRequest(`Unknown dayparts: ${badDayparts.join(", ")}`);
  }
  const sizeIds = new Set(DOOH_SIZE_SPECS.map((s) => s.id));
  const badSizes = body.placements.filter((p) => p.sizeId && !sizeIds.has(p.sizeId));
  if (badSizes.length > 0) {
    return badRequest(`Unknown DOOH size ids: ${[...new Set(badSizes.map((p) => p.sizeId))].join(", ")}`);
  }

  // Bind Studio creatives by id + sha256 hash (Creative Studio, Phase 4).
  const creativeHashes: string[] = [];
  for (const creativeId of body.creativeIds) {
    const creative = await prisma.mailCreative.findFirst({
      where: { id: creativeId, workspaceId: gate.workspaceId },
      select: { id: true, creativeHash: true, name: true },
    });
    if (!creative) return badRequest(`Creative not found in this workspace: ${creativeId}`);
    if (!creative.creativeHash) {
      return badRequest(`Creative "${creative.name}" has no hash yet — finalize it in Creative Studio first.`);
    }
    creativeHashes.push(creative.creativeHash);
  }

  const provider = getDoohProvider(body.vendor);
  let estimate;
  try {
    estimate = await provider.estimate({
      vendor: body.vendor,
      boardIds: body.placements.map((p) => p.boardId),
      dayparts: body.dayparts,
      flightStart: body.flightStart,
      flightEnd: body.flightEnd,
      playsPerBoardPerDay: body.playsPerBoardPerDay,
      weeklyImpressions: body.weeklyImpressions,
    });
  } catch (e) {
    return badRequest(e instanceof Error ? e.message : "Estimate failed");
  }

  const store = new SqlDoohPlanStore();
  const plan = await store.create({
    workspaceId: gate.workspaceId,
    name: body.name,
    vendor: body.vendor,
    placementsJson: {
      placements: body.placements,
      dayparts: body.dayparts,
      flightStart: body.flightStart,
      flightEnd: body.flightEnd,
      playsPerBoardPerDay: body.playsPerBoardPerDay ?? null,
      weeklyImpressions: body.weeklyImpressions ?? null,
    },
    estimateJson: {
      basis: "documented_estimate",
      vendor: body.vendor,
      lines: estimate.lines,
      minCents: estimate.minCents,
      maxCents: estimate.maxCents,
      notes: estimate.notes,
    },
    estimateCents: estimate.maxCents,
    currency: "USD",
    creativeIds: body.creativeIds,
    creativeHashes,
    createdBy: gate.userId,
  });

  // Buying-lifecycle audit (append-only): plan.created.
  await appendBuyingEvent({
    workspaceId: gate.workspaceId,
    actor: gate.userId,
    action: "plan.created",
    entityType: "dooh_plan",
    entityId: plan.id,
    payloadHash: createHash("sha256").update(JSON.stringify(estimate)).digest("hex"),
    detail: { name: plan.name, vendor: plan.vendor, estimateCents: plan.estimateCents, boards: (body.placements ?? []).length },
  });
  return Response.json({ plan, estimate }, { status: 201 });
}
