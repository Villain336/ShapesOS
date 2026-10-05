// ShapesOS — Phase 10 (portal): POST /api/portal/invoices/[id]/pay — a Stripe
// Checkout link for the balance of a linked, open invoice, created with the
// WORKSPACE'S OWN Stripe key (lib/ops/finance/stripe.ts; 409 until it is
// connected). portalGuard: portal cookie + CSRF + the invoice_pay action
// (editor+ clients). Creating a link moves no money; the payment lands
// through the signed tenant webhook.

import { portalBaseUrl, portalError, portalGuard } from "@/lib/portal/http";
import { portalPayInvoice } from "@/lib/portal/data";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const p = await portalGuard(req, { section: "invoices", action: "invoice_pay" });
  if (p instanceof Response) return p;
  try {
    const link = await portalPayInvoice(p, (await params).id, { baseUrl: portalBaseUrl(req) });
    return Response.json({ url: link.url }, { status: 201 });
  } catch (err) {
    return portalError(err);
  }
}
