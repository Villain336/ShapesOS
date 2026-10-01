// Marketr — Wave 2 Insurance slice 2: submissions + quoting API.
// GET  /api/insurance/submissions — list submissions with their quotes
// POST /api/insurance/submissions — intake (editor+) → vendor submit → fetch
//        quotes → persist submission + quotes. request_quote is the lightest
//        governed action: workspace editor role. Binding is NOT here — slice 3.

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { LINE_LABELS, type InsuranceLineOfBusiness } from "@/lib/insurance/types";
import {
  deriveSubmissionStatus,
  normalizeQuotes,
  validateSubmissionIntake,
  type RawVendorQuote,
} from "@/lib/insurance/quoting";
import { CoverForceVendor } from "@/lib/insurance/coverforce";

export const dynamic = "force-dynamic";

const LINE_VALUES = Object.keys(LINE_LABELS) as InsuranceLineOfBusiness[];

const LossEntrySchema = z.object({
  year: z.number().int(),
  claimCount: z.number().int().min(0),
  totalCents: z.number().int().min(0),
});

const IntakeSchema = z.object({
  line: z.enum(LINE_VALUES as [InsuranceLineOfBusiness, ...InsuranceLineOfBusiness[]]),
  applicantName: z.string().trim().min(1).max(200),
  operationsDescription: z.string().trim().max(2000).nullable().optional(),
  state: z.string().trim().length(2),
  classCode: z.string().trim().max(20).nullable().optional(),
  payrollCents: z.number().int().min(0).nullable().optional(),
  revenueCents: z.number().int().min(0).nullable().optional(),
  targetLimitPerOccurrenceCents: z.number().int().min(0).nullable().optional(),
  targetLimitAggregateCents: z.number().int().min(0).nullable().optional(),
  lossHistory: z.array(LossEntrySchema).max(20).optional(),
});

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const submissions = await prisma.insuranceSubmission.findMany({
      where: { workspaceId: workspace.id },
      include: { quotes: { orderBy: { createdAt: "asc" } } },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return Response.json({
      submissions: submissions.map((s) => ({
        id: s.id,
        line: s.line,
        lineLabel: LINE_LABELS[s.line as InsuranceLineOfBusiness],
        applicantName: s.applicantName,
        state: s.state,
        status: s.status,
        vendorRef: s.vendorRef,
        createdAt: s.createdAt.toISOString(),
        quotes: normalizeQuotes(
          s.quotes.map(
            (q): RawVendorQuote => ({
              carrierName: q.carrierName,
              quotedPremiumCents: q.quotedPremiumCents,
              limitPerOccurrenceCents: q.limitPerOccurrenceCents,
              limitAggregateCents: q.limitAggregateCents,
              quoteExpiry: q.quoteExpiry?.toISOString() ?? "",
              status:
                q.status === "quoted" || q.status === "declined" || q.status === "referred"
                  ? q.status
                  : "quoted",
              declineReason: q.vendorNotes ?? undefined,
            }),
          ),
        ).map((q, i) => ({ ...q, id: s.quotes[i]!.id })),
      })),
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { workspace, user } = await guardWorkspace({ editor: true });
    const body = IntakeSchema.parse(await req.json());

    // Fail closed on the domain rules before any vendor contact.
    validateSubmissionIntake({
      line: body.line,
      applicantName: body.applicantName,
      operationsDescription: body.operationsDescription ?? undefined,
      state: body.state,
      classCode: body.classCode ?? undefined,
      payrollCents: body.payrollCents ?? null,
      revenueCents: body.revenueCents ?? null,
      targetLimitPerOccurrenceCents: body.targetLimitPerOccurrenceCents ?? null,
      targetLimitAggregateCents: body.targetLimitAggregateCents ?? null,
      lossHistory: body.lossHistory,
    });

    const vendor = new CoverForceVendor({ mode: "fixture" });
    const { submissionRef } = await vendor.submit({
      line: body.line,
      applicantName: body.applicantName,
      state: body.state.toUpperCase(),
      payrollCents: body.payrollCents ?? null,
      revenueCents: body.revenueCents ?? null,
    });
    const vendorQuotes = await vendor.getQuotes({ submissionRef });

    const result = await prisma.$transaction(async (tx) => {
      const submission = await tx.insuranceSubmission.create({
        data: {
          workspaceId: workspace.id,
          line: body.line,
          applicantName: body.applicantName,
          operationsDescription: body.operationsDescription ?? null,
          state: body.state.toUpperCase(),
          classCode: body.classCode ?? null,
          payrollCents: body.payrollCents ?? null,
          revenueCents: body.revenueCents ?? null,
          targetLimitPerOccurrenceCents: body.targetLimitPerOccurrenceCents ?? null,
          targetLimitAggregateCents: body.targetLimitAggregateCents ?? null,
          lossHistory: body.lossHistory ?? [],
          status: "submitted",
          vendorRef: submissionRef,
          submittedBy: user.id,
        },
      });
      const quoteStatuses = vendorQuotes.map((vq) =>
        vq.status === "quoted" ? "quoted" : vq.status === "referred" ? "referred" : "declined",
      ) as Array<"quoted" | "declined" | "referred">;
      await tx.insuranceQuote.createMany({
        data: vendorQuotes.map((vq, i) => ({
          workspaceId: workspace.id,
          submissionId: submission.id,
          carrierName: vq.carrierName,
          quotedPremiumCents: vq.quotedPremiumCents,
          limitPerOccurrenceCents: vq.limitPerOccurrenceCents,
          limitAggregateCents: vq.limitAggregateCents,
          quoteExpiry: vq.quoteExpiry ? new Date(vq.quoteExpiry) : null,
          status: quoteStatuses[i]!,
          vendorNotes: vq.declineReason ?? null,
          rawPayload: { fixture: true, vendor: "coverforce" },
        })),
      });
      const derived = deriveSubmissionStatus(quoteStatuses);
      const updated = await tx.insuranceSubmission.update({
        where: { id: submission.id },
        data: { status: derived === "submitted" ? "submitted" : derived },
        include: { quotes: true },
      });
      return updated;
    });

    return Response.json(
      {
        submissionId: result.id,
        vendorRef: result.vendorRef,
        status: result.status,
        live: false,
        quotes: normalizeQuotes(
          result.quotes.map(
            (q): RawVendorQuote => ({
              carrierName: q.carrierName,
              quotedPremiumCents: q.quotedPremiumCents,
              limitPerOccurrenceCents: q.limitPerOccurrenceCents,
              limitAggregateCents: q.limitAggregateCents,
              quoteExpiry: q.quoteExpiry?.toISOString() ?? "",
              status:
                q.status === "quoted" || q.status === "declined" || q.status === "referred"
                  ? q.status
                  : "quoted",
              declineReason: q.vendorNotes ?? undefined,
            }),
          ),
        ),
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
