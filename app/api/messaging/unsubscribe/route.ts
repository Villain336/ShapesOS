// Marketr — /api/messaging/unsubscribe (no session auth — signed token).
//
// One-click email opt-out (CAN-SPAM / RFC 8058). The token is per-message,
// HMAC-signed, and binds workspaceId + messageId + leadId.
//
// GET  ?token=… → process and render a plain confirmation page
//                 (footer links in email clients are GETs).
// POST { token } → process and return JSON (RFC 8058 one-click).

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyUnsubscribeToken, optOut } from "@/lib/messaging/consent";

export const dynamic = "force-dynamic";

async function processUnsubscribe(token: string): Promise<{ ok: boolean; error?: string }> {
  const payload = verifyUnsubscribeToken(token);
  if (!payload) return { ok: false, error: "Invalid or expired unsubscribe link" };

  const message = await prisma.outboundMessage.findFirst({
    where: { id: payload.messageId, workspaceId: payload.workspaceId },
    select: { id: true, leadId: true, channel: true },
  });
  const leadId = payload.leadId ?? message?.leadId ?? null;
  if (!leadId) return { ok: false, error: "Invalid or expired unsubscribe link" };

  // Idempotent: opting out twice is a no-op, never an error.
  await optOut(payload.workspaceId, leadId, "email", "email one-click unsubscribe");
  return { ok: true };
}

const CONFIRM_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Unsubscribed</title></head>
<body style="font-family:system-ui,sans-serif;max-width:560px;margin:64px auto;padding:0 24px">
<h1>You've been unsubscribed</h1>
<p>You won't receive marketing emails from this sender anymore.</p>
</body></html>`;

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const res = await processUnsubscribe(token);
  if (!res.ok) {
    return new Response(`<p>${res.error}</p>`, {
      status: 400,
      headers: { "Content-Type": "text/html" },
    });
  }
  return new Response(CONFIRM_HTML, { headers: { "Content-Type": "text/html" } });
}

export async function POST(req: NextRequest) {
  let token = "";
  try {
    const body = (await req.json()) as { token?: unknown };
    token = typeof body.token === "string" ? body.token : "";
  } catch {
    // fall through to invalid
  }
  const res = await processUnsubscribe(token);
  if (!res.ok) return Response.json({ error: res.error }, { status: 400 });
  return Response.json({ ok: true });
}
