// Marketr — E-sign module: Documenso webhook receiver.
// POST /api/esign/webhooks/documenso
//
// PUBLIC BY DESIGN: Documenso's servers call this endpoint, so there is no
// user session to authorize. Authorization IS the webhook signature: the
// X-Documenso-Secret header is verified with a timing-safe compare BEFORE
// any JSON parsing, business logic, or database write. The raw body is read
// with req.text(); this route never parses unverified JSON. A bad signature
// is rejected with 401 (a forgery can never succeed); transient failures
// return 500 so Documenso redelivers (replays are idempotent via the audit
// log's bodyHash — B2 pattern from the billing webhook).
//
// This is the ONLY path that marks an envelope completed: completion requires
// the vendor's DOCUMENT_COMPLETED event, never a poll or a guess.

import { createDocumensoVendor } from "@/lib/esign/documenso-vendor";
import { ingestDocumensoWebhook } from "@/lib/esign/envelopes";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // Raw bytes for signature verification — never req.json() first.
  const rawBody = await req.text();
  const secretHeader = req.headers.get("x-documenso-secret");

  const vendor = createDocumensoVendor();
  let result;
  try {
    result = await ingestDocumensoWebhook(prisma, vendor, {
      rawBody,
      secretHeader,
    });
  } catch {
    return Response.json({ ok: false, reason: "webhook_failed" }, { status: 500 });
  }

  if (!result.ok) {
    // Permanent failures (forgery, malformed body): 4xx so the delivery is
    // not endlessly retried as if it might succeed.
    const status = result.reason === "bad_signature" ? 401 : 400;
    return Response.json({ ok: false, reason: result.reason }, { status });
  }
  if ("deduped" in result) {
    return Response.json({ ok: true, deduped: true });
  }
  if ("ignored" in result) {
    return Response.json({ ok: true, ignored: result.ignored });
  }
  return Response.json({ ok: true, applied: result.applied });
}
