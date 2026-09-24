// Marketr — POST /api/messaging/consent
//
// Manually set a lead's per-channel consent:
// { leadId, channel: "sms"|"email"|"voice", status, source? }
// Editor+ only. Prefer the inbound STOP/HELP/START webhook for
// recipient-driven changes; this route is the manual override.

import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { messagingGuard, badRequest } from "../_lib";
import { setConsent, type ConsentChannel, type ConsentStatus } from "@/lib/messaging/consent";

export const dynamic = "force-dynamic";

const ConsentSchema = z.object({
  leadId: z.string().trim().min(1).max(64),
  channel: z.enum(["sms", "email", "voice"]),
  status: z.enum(["unknown", "pending", "opted_in", "opted_out"]),
  source: z.string().trim().max(200).optional(),
});

export async function POST(req: NextRequest) {
  const gate = await messagingGuard("editor");
  if (gate instanceof Response) return gate;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest("Invalid JSON");
  }
  const parsed = ConsentSchema.safeParse(raw);
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);
  const d = parsed.data;

  const lead = await prisma.lead.findFirst({
    where: { id: d.leadId, workspaceId: gate.workspaceId },
    select: { id: true },
  });
  if (!lead) return Response.json({ error: "Lead not found" }, { status: 404 });

  const row = await setConsent(
    gate.workspaceId,
    d.leadId,
    d.channel as ConsentChannel,
    d.status as ConsentStatus,
    d.source ?? `manual (user ${gate.userId})`,
  );
  return Response.json({ consent: row });
}
