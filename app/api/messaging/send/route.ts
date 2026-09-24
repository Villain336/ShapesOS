// Marketr — POST /api/messaging/send
//
// Validate → requestApproval → queueMessage. Phase 3 is manual-only: the
// message stays "queued" behind the pending ApprovalItem until a human
// approves it (POST /api/messaging/approvals/[id]).

import type { NextRequest } from "next/server";
import { z } from "zod";
import { messagingGuard, badRequest } from "../_lib";
import {
  queueMessage,
  requestApproval,
  approvalKindFor,
  type MessageChannel,
  type MessageKind,
} from "@/lib/messaging/dispatcher";

export const dynamic = "force-dynamic";

const SendSchema = z.object({
  leadId: z.string().trim().min(1).max(64),
  channel: z.enum(["sms", "email"]),
  kind: z.enum([
    "sequence",
    "speed_to_lead",
    "missed_call_textback",
    "review_request",
    "broadcast",
    "manual",
  ]),
  subject: z.string().trim().max(200).optional(),
  body: z.string().trim().min(1).max(5000),
  scheduledFor: z.string().trim().max(64).optional(),
  requestedBy: z.string().trim().max(120).optional(),
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
  const parsed = SendSchema.safeParse(raw);
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);
  const d = parsed.data;

  let scheduledFor: Date | undefined;
  if (d.scheduledFor) {
    const t = new Date(d.scheduledFor);
    if (Number.isNaN(t.getTime())) return badRequest("scheduledFor is not a valid date");
    scheduledFor = t;
  }

  try {
    const approval = await requestApproval({
      workspaceId: gate.workspaceId,
      kind: approvalKindFor(d.kind as MessageKind),
      payload: {
        messageKind: d.kind,
        channel: d.channel,
        leadId: d.leadId,
        subject: d.subject ?? null,
        body: d.body,
        scheduledFor: scheduledFor?.toISOString() ?? null,
      },
      requestedBy: d.requestedBy,
    });
    const message = await queueMessage({
      workspaceId: gate.workspaceId,
      leadId: d.leadId,
      channel: d.channel as MessageChannel,
      kind: d.kind as MessageKind,
      subject: d.subject,
      body: d.body,
      approvalId: approval.id,
      scheduledFor,
      requestedBy: d.requestedBy,
    });
    return Response.json(
      {
        message,
        approval: { id: approval.id, kind: approval.kind, status: approval.status },
      },
      { status: 201 },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Send failed";
    const status = msg.includes("not found") ? 404 : 400;
    return Response.json({ error: msg }, { status });
  }
}
