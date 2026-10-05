// ShapesOS — Phase 10 (finance): work the generic /api/ops/[entity] route
// does AFTER a write committed — email delivery of a just-sent invoice or
// quote. Never inside the money transaction; never throws (the outcome is
// recorded on the document and returned to the caller).

import type { OpsActor } from "../doctype";
import { deliverInvoice } from "./invoicing";
import { deliverQuote } from "./quotes";
import type { DeliveryResult } from "./delivery";

export async function deliverAfterSend(
  actor: OpsActor,
  slug: string,
  row: Record<string, unknown> | undefined,
  body: unknown,
): Promise<DeliveryResult | null> {
  const asked = (body as Record<string, unknown> | null)?.status;
  if (!row || asked !== "sent" || row.status !== "sent" || typeof row.id !== "string") return null;
  try {
    if (slug === "invoices") return await deliverInvoice(actor, row.id);
    if (slug === "quotes") return await deliverQuote(actor, row.id);
  } catch (err) {
    console.error(`[finance-mail] post-send delivery failed for ${slug} ${row.id}: ${(err as Error)?.name ?? "error"}`);
    return { status: "failed", message: "The document was sent in the books, but the email step failed. Download the PDF and send it yourself." };
  }
  return null;
}
