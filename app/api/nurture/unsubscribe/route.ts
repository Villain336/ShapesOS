// Marketr — R3 per-lead unsubscribe landing.
// GET /api/nurture/unsubscribe?lead=<id>&channel=<sms|email|voice>
//
// Target of the {{unsubscribeUrl}} placeholder in sequence templates.
// Public (link clicked from a phone/email client); flips that lead's
// channel consent to "opted_out" with source "unsubscribe_link".

import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const CHANNELS = ["sms", "email", "voice"] as const;

function page(ok: boolean, leadName: string | null): Response {
  const title = ok ? "You've been unsubscribed" : "Invalid link";
  const body = ok
    ? `<p>${leadName ? `<strong>${leadName}</strong>, you` : "You"} will no longer receive these messages. Changed your mind? Reply to any message to opt back in.</p>`
    : `<p>This unsubscribe link is invalid.</p>`;
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — ShapesOS</title></head>` +
      `<body style="font-family:Arial,Helvetica,sans-serif;background:#f8f7f4;margin:0;padding:48px 16px">` +
      `<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;text-align:center;border:1px solid #e7e5e4">` +
      `<h1 style="font-size:20px;color:#1c1917">${title}</h1>${body}</div></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const leadId = sp.get("lead") ?? "";
  const channel = sp.get("channel") ?? "";
  if (!leadId || !(CHANNELS as readonly string[]).includes(channel)) {
    return page(false, null);
  }

  const lead = await prisma.lead.findFirst({
    where: { id: leadId },
    select: { id: true, workspaceId: true, name: true },
  });
  if (!lead) return page(false, null);

  await prisma.contactConsent.upsert({
    where: {
      workspaceId_leadId_channel: { workspaceId: lead.workspaceId, leadId: lead.id, channel },
    },
    create: {
      workspaceId: lead.workspaceId,
      leadId: lead.id,
      channel,
      status: "opted_out",
      source: "unsubscribe_link",
      optedOutAt: new Date(),
    },
    update: { status: "opted_out", source: "unsubscribe_link", optedOutAt: new Date() },
  });
  return page(true, lead.name);
}
