// Marketr — GET/POST /api/media/audio/briefs (Phase 5 B2).
//
// POST: plan a streaming-audio buy and generate the self-serve execution
//   brief (editor+). Vendor minimums are enforced in planAudioBuy — the
//   brief's total envelope is what the approval binding will cap.
// GET: list audio buys (viewer+).

import type { NextRequest } from "next/server";
import { z } from "zod";
import { mediaGuard, badRequest } from "../../_lib";
import { prisma } from "@/lib/prisma";
import {
  planAudioBuy,
  generateAudioBriefPdf,
  type AudioPlanInput,
} from "@/lib/media/audio";
import { SqlAudioBuyStore, appendBuyingEvent, buyingTablesReady } from "@/lib/media/buying-store";

export const dynamic = "force-dynamic";

const StationSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["streaming", "podcast"]),
  market: z.string().min(1),
  dayparts: z.array(z.string()).optional(),
});

const SpotMixSchema = z.object({
  lengthSec: z.union([z.literal(15), z.literal(30), z.literal(60)]),
  spotsPerDay: z.number().int().min(1).max(10000),
  label: z.string().min(1),
});

const PromoCodeSchema = z.object({
  stationRef: z.string().min(1),
  code: z.string().min(1),
  vanityUrl: z.string().min(1),
});

const CreateAudioSchema = z.object({
  name: z.string().trim().min(1).max(120),
  vendor: z.enum(["fake", "spotify", "acast", "audiogo"]),
  stations: z.array(StationSchema).min(1).max(50),
  spotMix: z.array(SpotMixSchema).min(1).max(10),
  flightStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  flightEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dailyBudgetCents: z.number().int().min(1),
  productionCents: z.number().int().min(0).optional(),
  promoCodes: z.array(PromoCodeSchema).default([]),
  creativeIds: z.array(z.string()).max(20).default([]),
});

export async function GET() {
  const gate = await mediaGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await buyingTablesReady())) {
    return Response.json({ error: "Phase 5 buying tables are not yet migrated.", briefs: [] }, { status: 503 });
  }
  const store = new SqlAudioBuyStore();
  return Response.json({ briefs: await store.list(gate.workspaceId) });
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
  const parsed = CreateAudioSchema.safeParse(raw);
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);
  const body = parsed.data;

  // Bind Studio creatives by id + sha256 hash.
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

  const input: AudioPlanInput = {
    vendor: body.vendor,
    name: body.name,
    stations: body.stations,
    spotMix: body.spotMix,
    flightStart: body.flightStart,
    flightEnd: body.flightEnd,
    dailyBudgetCents: body.dailyBudgetCents,
    productionCents: body.productionCents,
    promoCodes: body.promoCodes,
    creativeIds: body.creativeIds,
    creativeHashes,
  };

  let budget;
  try {
    budget = planAudioBuy(input);
  } catch (e) {
    return badRequest(e instanceof Error ? e.message : "Audio plan failed");
  }

  const store = new SqlAudioBuyStore();
  const buy = await store.create({
    workspaceId: gate.workspaceId,
    name: body.name,
    vendor: body.vendor,
    stationsJson: {
      stations: body.stations,
      spotMix: body.spotMix,
      flightStart: body.flightStart,
      flightEnd: body.flightEnd,
    },
    budgetJson: budget as unknown as Record<string, unknown>,
    budgetCents: budget.totalCents,
    currency: budget.currency,
    creativeIds: body.creativeIds,
    creativeHashes,
    createdBy: gate.userId,
  });

  const workspace = await prisma.workspace.findUnique({
    where: { id: gate.workspaceId },
    select: { name: true },
  });
  const brief = await generateAudioBriefPdf({
    buy: { id: buy.id, workspaceId: buy.workspaceId, name: buy.name, vendor: buy.vendor },
    input,
    budget,
    workspaceName: workspace?.name ?? "Marketr",
    generatedBy: gate.userId,
  });
  await store.setBrief(buy.id, gate.workspaceId, brief.pdfUrl);

  // Buying-lifecycle audit (append-only): audio_brief.generated.
  await appendBuyingEvent({
    workspaceId: gate.workspaceId,
    actor: gate.userId,
    action: "audio_brief.generated",
    entityType: "audio_buy",
    entityId: buy.id,
    payloadHash: brief.briefSha256,
    detail: { name: buy.name, vendor: buy.vendor, budgetCents: budget.totalCents },
  });
  return Response.json(
    { buy: { ...buy, briefUrl: brief.pdfUrl, status: "briefed" }, budget, briefSha256: brief.briefSha256 },
    { status: 201 },
  );
}
