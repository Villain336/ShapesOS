// Marketr — Physical attribution kit: public promo redemption.
// POST /api/attribution/bundles/redeem → { code, email?, phone?, name? }
//
// Capability model: the promo code (WAVE-XXXXXX, unguessable) IS the
// capability — possession authorizes exactly one action: redeeming that
// bundle's code into its workspace. The code resolves the workspace, so the
// endpoint is token-less by design. Defenses in depth:
//   - code normalized + compared as an exact DB lookup; unknown/disabled
//     codes 404 with a generic message (no oracle: "Invalid or expired"),
//   - per-code+IP rate limit (10/min; lib/physical/bundles.ts), inside the
//     proxy's write-tier limiter,
//   - Zod validation + body-size cap; email or phone required (no anonymous
//     lead creation),
//   - redemption is unique per (bundle, lead): re-submits don't double-count.

import { z } from "zod";
import {
  redeemPromoCode,
  checkRedeemRateLimit,
} from "@/lib/physical/bundles";
import { clientIpFromHeaders } from "@/lib/api/client-ip";

const RedeemSchema = z.object({
  code: z.string().trim().min(1).max(32),
  email: z.string().trim().max(254).optional(),
  phone: z.string().trim().max(40).optional(),
  name: z.string().trim().max(160).optional(),
});

function clientIp(req: Request): string {
  return clientIpFromHeaders(req.headers) ?? "unknown";
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    const text = await req.text();
    if (text.length > 8_192) {
      return Response.json({ error: "Request too large" }, { status: 413 });
    }
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = RedeemSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
  }
  const d = parsed.data;
  if (!d.email && !d.phone) {
    return Response.json({ error: "Email or phone is required to redeem" }, { status: 400 });
  }

  const ip = clientIp(req);
  if (!(await checkRedeemRateLimit(d.code, ip))) {
    return Response.json({ error: "Too many attempts, try again later" }, { status: 429 });
  }

  try {
    const res = await redeemPromoCode({ ...d, ip });
    return Response.json({ ok: true, ...res }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Redemption failed";
    // No oracle: invalid code and disabled bundle look identical.
    const status = msg === "Invalid or expired promo code" ? 404 : 400;
    return Response.json({ error: msg }, { status });
  }
}
