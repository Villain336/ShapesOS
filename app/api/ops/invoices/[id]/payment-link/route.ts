// ShapesOS — Phase 10 (finance): POST /api/ops/invoices/[id]/payment-link.
// Creates a Stripe Checkout Session for the invoice's balance with the
// WORKSPACE'S OWN Stripe key (never the platform billing key). Without a key
// it answers 409 "Connect Stripe first". Editor+. Creating a link moves no
// money; the payment lands through the signed webhook.

import { createInvoiceCheckout } from "@/lib/ops/finance/stripe";
import { financeError, financeGuard } from "@/lib/ops/finance/http";
import { appBaseUrl } from "@/lib/workspace/invite-mail";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await financeGuard("editor");
  if (actor instanceof Response) return actor;
  try {
    const { id } = await params;
    const baseUrl = appBaseUrl(process.env, new URL(req.url).origin) ?? new URL(req.url).origin;
    const link = await createInvoiceCheckout(actor, id, { baseUrl });
    return Response.json(link, { status: 201 });
  } catch (err) {
    return financeError(err);
  }
}
