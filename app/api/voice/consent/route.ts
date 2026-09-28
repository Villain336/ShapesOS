// Marketr — Phase 13D: consent management API.
// GET  /api/voice/consent?channel=&status= → per-lead consent rows
// POST /api/voice/consent { leadId, channel, status: opted_in|opted_out, source? }
//
// Workspace resolves from the session (guardWorkspace), matching the
// Worker-B voice routes. Editor role required for mutations.

import type { NextRequest } from "next/server";
import {
  guardWorkspace,
  httpErrorResponse,
  readJson,
  HttpError,
} from "@/lib/enrichment/guard";
import { listLeadConsent, upsertConsent } from "@/lib/voice/consent";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const { workspace } = await guardWorkspace();
    const q = req.nextUrl.searchParams;
    const rows = await listLeadConsent(workspace.id, {
      channel: (q.get("channel") ?? undefined) as "voice" | "sms" | "chat" | undefined,
      status: (q.get("status") ?? undefined) as never,
    });
    return Response.json({ consent: rows });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as Record<string, unknown>;
    const channel = String(body.channel ?? "");
    const status = String(body.status ?? "");
    if (!["voice", "sms", "chat"].includes(channel))
      return httpErrorResponse(new HttpError(400, "channel must be voice, sms, or chat"));
    if (!["opted_in", "opted_out"].includes(status))
      return httpErrorResponse(new HttpError(400, "status must be opted_in or opted_out"));
    if (!body.leadId)
      return httpErrorResponse(new HttpError(400, "leadId is required"));
    const row = await upsertConsent(
      workspace.id,
      String(body.leadId),
      channel as "voice" | "sms" | "chat",
      status as "opted_in" | "opted_out",
      body.source ? String(body.source) : undefined,
    );
    return Response.json({ consent: row });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
