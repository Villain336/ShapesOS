// ShapesOS — Phase 12 (people): POST /api/events/[slug]/register
//   { ticketTypeId, quantity, name, email, attendees?: [{ name, email? }], captchaToken? }
//   → 201 { status: "confirmed", viewUrl }            free tickets
//   → 201 { status: "payment_required", url }         paid: the tenant's Stripe Checkout
//
// PUBLIC BY DESIGN (registrants have no account): only a PUBLISHED event
// resolves (SELECT-only app.event_route policy; unknown / draft → 404).
// Price, sales window and seats are re-checked server-side from the
// database (never client prices); seats are reserved with row-locked
// counters + DB CHECKs, so concurrent registrations can never oversell.
// Paid tickets: the registration stays PENDING and the seats are held until
// the Stripe-signed tenant webhook confirms payment (or the hold expires);
// the Checkout Session uses the WORKSPACE'S OWN Stripe key (no key → 409,
// never a fake success). Bot protection: per-event+IP limit (10 / 10 min)
// plus the CAPTCHA step-up from the second attempt when a provider is
// configured (lib/auth/captcha.ts). 16 KiB body cap. Returns ids/URLs only.

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { clientIpFromHeaders } from "@/lib/api/client-ip";
import { OpsError } from "@/lib/ops/doctype";
import { appBaseUrl } from "@/lib/workspace/invite-mail";
import { checkoutCaptchaDue, publicEndpointHit, verifyCaptchaToken } from "@/lib/ops/store/limits";
import { resolvePublishedEvent } from "@/lib/ops/events/catalog";
import { EventPaymentsNotConnectedError, registerPublic } from "@/lib/ops/events/registrations";
import { TicketConfigError } from "@/lib/ops/events/tickets";

export const dynamic = "force-dynamic";

const BODY_LIMIT = 16 * 1024;
const EVENT_REGISTER_LIMIT = { limit: 10, windowMs: 10 * 60_000 } as const;

type Params = { params: Promise<{ slug: string }> };

const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : "");

export async function POST(req: NextRequest, { params }: Params) {
  const { slug } = await params;
  const event = await resolvePublishedEvent(slug);
  if (!event) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const ip = clientIpFromHeaders(req.headers);
  const hit = await publicEndpointHit("events:register", EVENT_REGISTER_LIMIT, event.id, ip);
  if (!hit.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(Math.max(1, Math.ceil(hit.retryAfterMs / 1000))) } },
    );
  }
  const raw = await req.text();
  if (raw.length > BODY_LIMIT) return NextResponse.json({ error: "Request too large" }, { status: 413 });
  let body: Record<string, unknown>;
  try {
    const v = raw.trim() ? (JSON.parse(raw) as unknown) : {};
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    body = v as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (checkoutCaptchaDue(hit.count) && !(await verifyCaptchaToken(str(body.captchaToken, 4000), ip))) {
    return NextResponse.json({ error: "Complete the security check, then try again.", code: "captcha_required" }, { status: 400 });
  }
  const quantity = Number(body.quantity ?? 1);
  const attendees = Array.isArray(body.attendees)
    ? body.attendees.slice(0, 100).map((a) => {
        const o = (a ?? {}) as Record<string, unknown>;
        return { name: str(o.name, 200), email: str(o.email, 320) || null };
      })
    : undefined;
  try {
    const origin = new URL(req.url).origin;
    const baseUrl = appBaseUrl(process.env, origin) ?? origin;
    const out = await registerPublic(
      event,
      { ticketTypeId: str(body.ticketTypeId, 64), quantity, name: str(body.name, 200), email: str(body.email, 320), attendees },
      { baseUrl },
    );
    const headers = { "Cache-Control": "no-store" };
    if (out.status === "confirmed") {
      return NextResponse.json({ status: out.status, viewUrl: `/events/${event.slug}/registered?k=${encodeURIComponent(out.viewToken)}` }, { status: 201, headers });
    }
    return NextResponse.json({ status: out.status, url: out.url }, { status: 201, headers });
  } catch (err) {
    if (err instanceof EventPaymentsNotConnectedError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    if (err instanceof OpsError) return NextResponse.json({ error: err.message }, { status: err.status });
    if (err instanceof TicketConfigError) return NextResponse.json({ error: "Registration is temporarily unavailable." }, { status: 503 });
    console.error(`[event-register] ${event.id}: ${(err as Error)?.name ?? "error"}`);
    return NextResponse.json({ error: "Registration failed. Try again in a moment." }, { status: 500 });
  }
}
