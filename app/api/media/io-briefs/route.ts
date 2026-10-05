// Marketr — GET/POST /api/media/io-briefs (Phase 5 B3).
//
// POST: generate an IO brief on the IAB/AAAA template (editor+). The
//   maximum amount to be spent is THE binding term — the scheduled total
//   may never exceed it. The rep keeps the signature; signature_status
//   tracks draft → sent_to_rep → signed → proof_received.
// GET: list IO briefs (viewer+).

import type { NextRequest } from "next/server";
import { z } from "zod";
import { mediaGuard, badRequest } from "../_lib";
import { prisma } from "@/lib/prisma";
import {
  buildIoTerms,
  generateIoBriefPdf,
  IO_SIGNATURE_FLOW,
  type IoChannel,
  type IoSignatureStatus,
} from "@/lib/media/io-briefs";
import { SqlIoBriefStore, appendBuyingEvent, buyingTablesReady } from "@/lib/media/buying-store";

export const dynamic = "force-dynamic";

const DeliverableSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().int().min(1),
  unitPriceCents: z.number().int().min(0),
  totalCents: z.number().int().min(0),
  notes: z.string().max(500).optional(),
});

const RepContactSchema = z.object({
  name: z.string().min(1),
  company: z.string().min(1),
  email: z.string().email().optional(),
  phone: z.string().max(40).optional(),
  rateCardRef: z.string().max(200).optional(),
});

const InventorySchema = z.object({
  name: z.string().min(1),
  market: z.string().min(1),
  callSign: z.string().max(20).optional(),
  daypartMix: z.string().max(200).optional(),
  placement: z.string().max(200).optional(),
});

const CreateIoSchema = z.object({
  name: z.string().trim().min(1).max(120),
  channel: z.enum(["radio", "newspaper", "magazine"]),
  inventory: z.array(InventorySchema).min(1).max(50),
  deliverables: z.array(DeliverableSchema).min(1).max(100),
  maximumSpendCents: z.number().int().min(1),
  currency: z.string().length(3).default("USD"),
  flightStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  flightEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  thirdPartyAdServer: z.string().trim().min(1).max(200),
  cancelTerms: z.string().trim().min(1).max(2000),
  paymentTerms: z.string().trim().min(1).max(2000),
  inventoryUnavailableNotice: z
    .string()
    .max(2000)
    .default("Publisher must notify within 2 business days if inventory is unavailable (IAB/AAAA)."),
  notes: z.string().max(2000).optional(),
  repContact: RepContactSchema.optional(),
  promoCodes: z.array(z.object({ channelRef: z.string().min(1), code: z.string().min(1) })).default([]),
  creativeIds: z.array(z.string()).max(20).default([]),
});

export async function GET() {
  const gate = await mediaGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await buyingTablesReady())) {
    return Response.json({ error: "Phase 5 buying tables are not yet migrated.", briefs: [] }, { status: 503 });
  }
  const store = new SqlIoBriefStore();
  return Response.json({ briefs: await store.list(gate.workspaceId), signatureFlow: IO_SIGNATURE_FLOW });
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
  const parsed = CreateIoSchema.safeParse(raw);
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

  let terms;
  try {
    terms = buildIoTerms({
      deliverables: body.deliverables,
      maximumSpendCents: body.maximumSpendCents,
      currency: body.currency,
      flightStart: body.flightStart,
      flightEnd: body.flightEnd,
      thirdPartyAdServer: body.thirdPartyAdServer,
      cancelTerms: body.cancelTerms,
      paymentTerms: body.paymentTerms,
      inventoryUnavailableNotice: body.inventoryUnavailableNotice,
      notes: body.notes,
    });
  } catch (e) {
    return badRequest(e instanceof Error ? e.message : "IO terms invalid");
  }

  const store = new SqlIoBriefStore();
  const brief = await store.create({
    workspaceId: gate.workspaceId,
    name: body.name,
    channel: body.channel,
    inventoryJson: { inventory: body.inventory },
    ioTermsJson: terms as unknown as Record<string, unknown>,
    maxSpendCents: terms.maximumSpendCents,
    currency: terms.currency,
    creativeIds: body.creativeIds,
    creativeHashes,
    repContact: (body.repContact ?? null) as unknown as Record<string, unknown> | null,
    createdBy: gate.userId,
  });

  const workspace = await prisma.workspace.findUnique({
    where: { id: gate.workspaceId },
    select: { name: true },
  });
  const pdf = await generateIoBriefPdf({
    brief: { id: brief.id, workspaceId: brief.workspaceId },
    input: {
      name: body.name,
      channel: body.channel as IoChannel,
      inventory: body.inventory,
      terms: {
        deliverables: body.deliverables,
        maximumSpendCents: body.maximumSpendCents,
        currency: body.currency,
        flightStart: body.flightStart,
        flightEnd: body.flightEnd,
        thirdPartyAdServer: body.thirdPartyAdServer,
        cancelTerms: body.cancelTerms,
        paymentTerms: body.paymentTerms,
        inventoryUnavailableNotice: body.inventoryUnavailableNotice,
        notes: body.notes,
      },
      repContact: body.repContact,
      creativeIds: body.creativeIds,
      creativeHashes,
      promoCodes: body.promoCodes,
    },
    terms,
    signatureStatus: "draft" as IoSignatureStatus,
    workspaceName: workspace?.name ?? "ShapesOS",
    generatedBy: gate.userId,
  });
  await store.setBriefPdf(brief.id, gate.workspaceId, pdf.pdfUrl);

  // Buying-lifecycle audit (append-only): io_brief.generated.
  await appendBuyingEvent({
    workspaceId: gate.workspaceId,
    actor: gate.userId,
    action: "io_brief.generated",
    entityType: "io_brief",
    entityId: brief.id,
    payloadHash: pdf.briefSha256,
    detail: { name: brief.name, channel: brief.channel, maximumSpendCents: terms.maximumSpendCents },
  });
  return Response.json(
    { brief: { ...brief, briefPdfUrl: pdf.pdfUrl }, terms, briefSha256: pdf.briefSha256 },
    { status: 201 },
  );
}
