// Marketr — R3 consent API.
// GET  /api/nurture/consent?q=&limit=           → lead × channel consent matrix
// POST /api/nurture/consent (editor+)           → upsert a consent state
//
// Consent states: "unknown" | "pending" | "opted_in" | "opted_out"
// (TCPA / CAN-SPAM). The dispatcher reads these at dispatch time; this API
// is the human-readable view and the manual override hatch.

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { nurtureCtx, requireNurtureEditor, readJson } from "../_lib";
import { setConsent } from "@/lib/messaging/consent";

export const dynamic = "force-dynamic";

const CHANNELS = ["sms", "email", "voice", "mail"] as const;
const CONSENT_STATUSES = ["unknown", "pending", "opted_in", "opted_out"] as const;

export async function GET(req: Request) {
  const ctx = await nurtureCtx();
  if (ctx instanceof Response) return ctx;
  const sp = new URL(req.url).searchParams;

  const q = sp.get("q")?.trim();
  const limit = Math.min(200, Math.max(1, Number(sp.get("limit") ?? "100") || 100));
  const leadWhere: Record<string, unknown> = { workspaceId: ctx.workspaceId };
  if (q) {
    leadWhere.OR = [
      { name: { contains: q, mode: "insensitive" } },
      { email: { contains: q, mode: "insensitive" } },
      { company: { contains: q, mode: "insensitive" } },
    ];
  }

  const leads = await prisma.lead.findMany({
    where: leadWhere as never,
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      company: true,
      consents: { select: { channel: true, status: true, source: true, consentedAt: true, optedOutAt: true } },
    },
    orderBy: { name: "asc" },
    take: limit,
  });

  const rows = leads.map((l) => {
    const byChannel: Record<string, string> = {};
    for (const c of CHANNELS) byChannel[c] = "unknown";
    for (const c of l.consents) byChannel[c.channel] = c.status;
    return { ...l, consent: byChannel };
  });
  return Response.json({ leads: rows });
}

const UpsertSchema = z.object({
  leadId: z.string().min(1),
  channel: z.enum(CHANNELS),
  status: z.enum(CONSENT_STATUSES),
  source: z.string().trim().max(40).optional(),
});

export async function POST(req: Request) {
  const ctx = await nurtureCtx();
  if (ctx instanceof Response) return ctx;
  const editor = await requireNurtureEditor(ctx);
  if (editor) return editor;

  const parsedBody = await readJson(req);
  if (!parsedBody.ok) return parsedBody.res;
  const parsed = UpsertSchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
  }
  const d = parsed.data;

  const lead = await prisma.lead.findFirst({
    where: { id: d.leadId, workspaceId: ctx.workspaceId },
    select: { id: true },
  });
  if (!lead) return Response.json({ error: "Lead not found" }, { status: 404 });

  const consent = await setConsent(ctx.workspaceId, d.leadId, d.channel, d.status, d.source ?? "manual");
  return Response.json({ consent }, { status: 200 });
}
