// Marketr — Wave 2 Insurance slice 3b: bind execution API.
// POST /api/insurance/quotes/[id]/bind — execute a bind for an approved
// bind_policy governed action (editor role).
//
// Body: { approvalId }. The ONLY execution entrypoint is executeBind
// (lib/insurance/binding.ts): quote must be quoted and unexpired, the
// approval must be an approved bind_policy approval whose disclosure still
// matches the quote, an appointed licensed partner must exist, and the
// vendor bind runs idempotently. Premium moves carrier-direct (zero
// custody); the OS never holds funds.
//
// Domain refusals → 404/409/422 with named error codes; never a silent skip.

import { z } from "zod";
import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { InsuranceError } from "@/lib/insurance/types";
import { InsuranceVendorError } from "@/lib/insurance/mock-vendor";
import {
  executeBind,
  serializeBindPolicy,
  serializePaymentHandoff,
} from "@/lib/insurance/binding";

export const dynamic = "force-dynamic";

const BindSchema = z.object({
  approvalId: z.string().trim().min(1).max(100),
});

function domainStatus(code: string): number {
  if (code === "QUOTE_NOT_FOUND") return 404;
  // State conflicts: the quote is not in a bindable state.
  if (
    code === "QUOTE_NOT_QUOTED" ||
    code === "QUOTE_EXPIRED" ||
    code === "QUOTE_STATE_INCONSISTENT"
  ) {
    return 409;
  }
  return 422;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { workspace, user } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const body = BindSchema.parse(await req.json());

    const result = await executeBind({
      workspaceId: workspace.id,
      quoteId: id,
      approvalId: body.approvalId,
      requestedBy: user.id,
    });

    // The vendor's carrier confirmation lives in the policy rawPayload
    // (not in the serialized policy); surface it so the UI can show the
    // carrier's confirmation alongside the minted policy number.
    const rawPayload = (result.policy.rawPayload ?? {}) as Record<string, unknown>;
    const carrierConfirmation =
      typeof rawPayload["carrierConfirmation"] === "string"
        ? (rawPayload["carrierConfirmation"] as string)
        : null;

    return Response.json(
      {
        policy: serializeBindPolicy(result.policy),
        carrierConfirmation,
        paymentHandoff: serializePaymentHandoff(result.paymentHandoff),
        live: result.live,
        replayed: result.replayed,
      },
      { status: result.replayed ? 200 : 201 },
    );
  } catch (e) {
    if (e instanceof z.ZodError) {
      return Response.json(
        { error: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") },
        { status: 400 },
      );
    }
    if (e instanceof InsuranceError || e instanceof InsuranceVendorError) {
      return Response.json(
        { error: e.message, code: e.code },
        { status: domainStatus(e.code) },
      );
    }
    return httpErrorResponse(e);
  }
}
