// Marketr — Wave 2 Insurance slice 1: policy inventory API.
// GET  /api/insurance/policies — list policies with carrier + alert level
// POST /api/insurance/policies — ingest a policy (editor+). Coverage data is
//        accepted only from explicit fields; anything not provided stays null
//        ("not confirmed") — the server never invents coverage.

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import {
  declarationsNeedReview,
  LINE_LABELS,
  parseDeclarationsText,
  renewalAlertLevel,
  validatePolicyInput,
  type InsuranceLineOfBusiness,
} from "@/lib/insurance/types";

export const dynamic = "force-dynamic";

const LINE_VALUES = Object.keys(LINE_LABELS) as InsuranceLineOfBusiness[];

const CreateSchema = z.object({
  policyNumber: z.string().trim().min(1).max(80),
  carrierName: z.string().trim().min(1).max(120),
  line: z.enum(LINE_VALUES as [InsuranceLineOfBusiness, ...InsuranceLineOfBusiness[]]),
  namedInsured: z.string().trim().min(1).max(200),
  effectiveAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  limitPerOccurrenceCents: z.number().int().min(0).nullable().optional(),
  limitAggregateCents: z.number().int().min(0).nullable().optional(),
  deductibleCents: z.number().int().min(0).nullable().optional(),
  annualPremiumCents: z.number().int().min(0).nullable().optional(),
  paymentSchedule: z.string().trim().max(60).nullable().optional(),
  /** Raw declarations text for the audit snapshot. */
  declarationsText: z.string().max(200_000).nullable().optional(),
});

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const policies = await prisma.insurancePolicy.findMany({
      where: { workspaceId: workspace.id },
      include: { carrier: { select: { name: true, amBestRating: true } } },
      orderBy: { expiresAt: "asc" },
    });
    return Response.json({
      policies: policies.map((p) => ({
        id: p.id,
        policyNumber: p.policyNumber,
        line: p.line,
        lineLabel: LINE_LABELS[p.line as InsuranceLineOfBusiness],
        carrierName: p.carrier.name,
        amBestRating: p.carrier.amBestRating,
        namedInsured: p.namedInsured,
        effectiveAt: p.effectiveAt.toISOString(),
        expiresAt: p.expiresAt.toISOString(),
        limitPerOccurrenceCents: p.limitPerOccurrenceCents,
        limitAggregateCents: p.limitAggregateCents,
        deductibleCents: p.deductibleCents,
        annualPremiumCents: p.annualPremiumCents,
        paymentSchedule: p.paymentSchedule,
        status: p.status,
        source: p.source,
        alertLevel: renewalAlertLevel(p.expiresAt),
      })),
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const body = CreateSchema.parse(await req.json());

    const effectiveAt = new Date(body.effectiveAt);
    const expiresAt = new Date(body.expiresAt);

    // Fail closed on the domain rules before touching the database.
    validatePolicyInput({
      policyNumber: body.policyNumber,
      carrierId: "pending",
      line: body.line,
      namedInsured: body.namedInsured,
      effectiveAt,
      expiresAt,
      limitPerOccurrenceCents: body.limitPerOccurrenceCents ?? null,
      limitAggregateCents: body.limitAggregateCents ?? null,
      deductibleCents: body.deductibleCents ?? null,
      annualPremiumCents: body.annualPremiumCents ?? null,
    });

    // If declarations text was supplied, surface the parse review flag —
    // low-confidence parses stay visible but are NOT blocked from manual entry.
    let reviewFlag = false;
    if (body.declarationsText) {
      reviewFlag = declarationsNeedReview(parseDeclarationsText(body.declarationsText));
    }

    const result = await prisma.$transaction(async (tx) => {
      const carrier = await tx.insuranceCarrier.upsert({
        where: {
          workspaceId_name: { workspaceId: workspace.id, name: body.carrierName },
        },
        update: {},
        create: {
          workspaceId: workspace.id,
          name: body.carrierName,
          appointmentPath: "dais_market_access",
          linesSupported: [body.line],
        },
      });
      const policy = await tx.insurancePolicy.create({
        data: {
          workspaceId: workspace.id,
          carrierId: carrier.id,
          policyNumber: body.policyNumber,
          line: body.line,
          namedInsured: body.namedInsured,
          effectiveAt,
          expiresAt,
          limitPerOccurrenceCents: body.limitPerOccurrenceCents ?? null,
          limitAggregateCents: body.limitAggregateCents ?? null,
          deductibleCents: body.deductibleCents ?? null,
          annualPremiumCents: body.annualPremiumCents ?? null,
          paymentSchedule: body.paymentSchedule ?? null,
          source: body.declarationsText ? "import" : "manual",
          rawPayload: body.declarationsText
            ? { declarationsText: body.declarationsText.slice(0, 50_000) }
            : {},
        },
      });
      const renewal = await tx.insuranceRenewal.create({
        data: {
          workspaceId: workspace.id,
          policyId: policy.id,
          renewalDate: expiresAt,
          priorPremiumCents: body.annualPremiumCents ?? null,
        },
      });
      return { policy, renewal };
    });

    return Response.json(
      {
        policyId: result.policy.id,
        renewalId: result.renewal.id,
        alertLevel: renewalAlertLevel(expiresAt),
        needsReview: reviewFlag,
      },
      { status: 201 },
    );
  } catch (e) {
    if (e instanceof z.ZodError) {
      return Response.json(
        { error: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") },
        { status: 400 },
      );
    }
    return httpErrorResponse(e);
  }
}
