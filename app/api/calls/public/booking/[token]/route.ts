// Marketr — Calls API: public booking page.
// GET  /api/calls/public/booking/[token] → page info + availability
// POST /api/calls/public/booking/[token] → submit a booking
//
// PUBLIC BY DESIGN: the unguessable token (mkbook_<32 hex>, stored as
// sha256) IS the capability. Rate-limited per page+IP. The POST body is
// capped. Consent is required — unchecked consent is a 400 and no reminders
// are ever queued.

import { findBookingPageByToken, getAvailability, handleBookingSubmit } from "@/lib/calls/booking";
import { clientIpFromHeaders } from "@/lib/api/client-ip";

const BODY_LIMIT = 4096;

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const page = await findBookingPageByToken(token);
  if (!page || !page.enabled) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const sp = new URL(req.url).searchParams;
  const parseDate = (v: string | null) => {
    if (!v) return undefined;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  };
  try {
    const { slots, settings } = await getAvailability({
      pageId: page.id,
      workspaceId: page.workspaceId,
      from: parseDate(sp.get("from")),
      to: parseDate(sp.get("to")),
    });
    return Response.json({
      page: {
        title: page.title,
        description: page.description,
        timezone: settings.timezone,
        durationMin: settings.durationMin,
      },
      slots,
    });
  } catch {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const rawBody = await req.text();
  if (rawBody.length > BODY_LIMIT) {
    return Response.json({ error: "Request too large" }, { status: 413 });
  }
  const ip = clientIpFromHeaders(req.headers) ?? "unknown";
  const res = await handleBookingSubmit({ token, rawBody, ip });
  return Response.json(res.json, { status: res.status, headers: res.headers });
}
