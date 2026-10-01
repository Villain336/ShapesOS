// Marketr — Wave 2 Insurance slice 4: surface a carrier auto-renewal.
// POST /api/insurance/renewals/[id]/surface-auto-renew — mark the renewal
// auto_renew_surfaced with the carrier's terms snapshot (editor role).
//
// Auto-renewals are detected and surfaced, NEVER silently accepted. The
// agent compares the carrier's renewal terms against the prior term and
// flags premium deltas above the threshold before anyone is asked to
// approve the renewal. Accepting the terms still routes through a renewal
// quote + the bind_policy gate.
//
// Body: { carrierTerms: { premiumCents?, limitPerOccurrenceCents?,
// limitAggregateCents?, effectiveDate?, expiryDate?, carrierName?, ... } }
// — an empty snapshot is refused (AUTO_RENEW_TERMS_REQUIRED).

import { z } from "zod";
import { guardWorkspace } from "@/lib/enrichment/guard";
import { surfaceAutoRenew } from "@/lib/insurance/renewals";
import {
  serializeRenewal,
  renewalErrorResponse,
} from "../../_shared";

export const dynamic = "force-dynamic";

const SurfaceSchema = z.object({
  carrierTerms: z.record(z.string(), z.unknown()),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const body = SurfaceSchema.parse(await req.json());

    const result = await surfaceAutoRenew(
      workspace.id,
      id,
      body.carrierTerms as Record<string, unknown>,
    );

    return Response.json({
      renewal: serializeRenewal(result.renewal),
      deltaFlagged: result.deltaFlagged,
      needsReview: result.needsReview,
    });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return Response.json(
        {
          error: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        },
        { status: 400 },
      );
    }
    return renewalErrorResponse(e);
  }
}
