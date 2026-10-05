// Marketr — R3 message log API (the OutboundMessage ledger view).
// GET /api/nurture/log?channel=&kind=&status=&q=&limit=
// Suppressed rows carry suppressionReason so the log doubles as the
// suppression audit trail.

import { prisma } from "@/lib/prisma";
import { nurtureCtx } from "../_lib";
import { intQuery, parseQuery, z } from "@/lib/api/validate";

export const dynamic = "force-dynamic";

const CHANNELS = ["sms", "email", "voice"] as const;
const KINDS = ["sequence", "speed_to_lead", "missed_call_textback", "review_request", "broadcast", "manual"] as const;
const STATUSES = ["queued", "sent", "delivered", "failed", "suppressed"] as const;

export async function GET(req: Request) {
  const ctx = await nurtureCtx();
  if (ctx instanceof Response) return ctx;
  const sp = new URL(req.url).searchParams;

  const where: Record<string, unknown> = { workspaceId: ctx.workspaceId };
  const channel = sp.get("channel");
  if (channel && (CHANNELS as readonly string[]).includes(channel)) where.channel = channel;
  const kind = sp.get("kind");
  if (kind && (KINDS as readonly string[]).includes(kind)) where.kind = kind;
  const status = sp.get("status");
  if (status && (STATUSES as readonly string[]).includes(status)) where.status = status;
  const q = sp.get("q")?.trim();
  if (q) {
    where.OR = [
      { body: { contains: q, mode: "insensitive" } },
      { lead: { name: { contains: q, mode: "insensitive" } } },
    ];
  }
  const limitQuery = parseQuery(z.object({ limit: intQuery(100, 1, 200) }), sp);
  if (!limitQuery.ok) return limitQuery.error;
  const limit = limitQuery.data.limit;

  const [messages, total] = await Promise.all([
    prisma.outboundMessage.findMany({
      where: where as never,
      include: {
        lead: { select: { id: true, name: true, email: true, phone: true, company: true } },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.outboundMessage.count({ where: where as never }),
  ]);
  return Response.json({ messages, total });
}
