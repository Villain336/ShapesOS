// Marketr — call tracking (R5): inbound call handling.
//
// The voice webhook records an in-progress Call; the status callback
// finalizes it. Finalization does four things in order:
//   1. updates the Call row (duration, recording, transcription, summary),
//   2. matches the caller to a Lead by phone number — or creates one,
//   3. logs a call-source attribution touch (channel "phone", source
//      "tracking-number") so C2 picks the call up,
//   4. writes a call activity to the lead timeline.
//   5. (best-effort) queues a missed-call text-back when the caller matches
//      a lead with SMS opt-in — lib/messaging/dispatcher.ts
//      queueMissedCallTextback. Under the manual-only approval policy the
//      text-back stays queued behind a pending ApprovalItem.
//
// call_minutes is a *usage dimension* (lib/calls/meter.ts) — read-only
// reporting like crm_active_leads, never a meter() credit charge.

import { prisma } from "@/lib/prisma";
import { createLeadRecord } from "@/lib/crm/leads";
import { logTouch } from "@/lib/attribution/touches";
import { logActivity } from "@/lib/crm/dedup";
import { getProvider, type TelephonyProvider } from "./provider";

export type CallStatus =
  | "in_progress"
  | "completed"
  | "missed"
  | "voicemail"
  | "busy"
  | "failed";

/** Strip to digits; the last 10 digits are the US caller-ID match key. */
export function normalizePhone(raw: string | null | undefined): string {
  const digits = (raw ?? "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

export interface InboundVoiceInput {
  /** The workspace the number belongs to — resolved by the route from To. */
  to: string;
  from: string;
  callSid: string;
  startedAt?: Date;
  provider?: TelephonyProvider;
}

export interface InboundVoiceResult {
  ok: boolean;
  callId?: string;
  /** Why the call was rejected (number not found / released). */
  reason?: "number_not_found" | "number_released";
  workspaceId?: string;
}

/**
 * Accept an inbound call. Idempotent on the provider call SID (a retried
 * webhook returns the existing Call). Released or unknown numbers are
 * rejected — the caller hears nothing, and no rows are written.
 */
export async function handleInboundVoice(input: InboundVoiceInput): Promise<InboundVoiceResult> {
  const number = await prisma.callNumber.findUnique({ where: { e164: input.to } });
  if (!number) return { ok: false, reason: "number_not_found" };
  if (number.status !== "active") return { ok: false, reason: "number_released" };

  const existing = await prisma.call.findUnique({
    where: { externalSid: input.callSid },
    select: { id: true },
  });
  if (existing) {
    return { ok: true, callId: existing.id, workspaceId: number.workspaceId };
  }

  const call = await prisma.call.create({
    data: {
      workspaceId: number.workspaceId,
      numberId: number.id,
      externalSid: input.callSid,
      from: input.from,
      to: input.to,
      direction: "inbound",
      status: "in_progress",
      startedAt: input.startedAt ?? new Date(),
    },
    select: { id: true },
  });
  return { ok: true, callId: call.id, workspaceId: number.workspaceId };
}

export interface CallStatusInput {
  callSid: string;
  /** Provider status: completed | busy | no-answer | failed | canceled. */
  providerStatus: string;
  durationSec?: number;
  recordingUrl?: string | null;
  transcription?: string | null;
  summaryFn?: CallSummarizer;
}

export type CallSummarizer = (args: {
  callSid: string;
  durationSec: number;
  status: CallStatus;
  transcript: string | null;
}) => string;

/** Default summarizer: deterministic template. An LLM summarizer plugs in
 *  here later via the existing agent LLM stack — same signature. */
export function defaultSummarizer(args: {
  callSid: string;
  durationSec: number;
  status: CallStatus;
  transcript: string | null;
}): string {
  const mm = Math.floor(args.durationSec / 60);
  const ss = String(args.durationSec % 60).padStart(2, "0");
  const outcome =
    args.status === "completed"
      ? `connected, ${mm}:${ss} talk time`
      : args.status === "missed"
        ? "no answer — caller hung up before pickup"
        : args.status === "voicemail"
          ? "went to voicemail"
          : `ended (${args.status})`;
  const hasTranscript = args.transcript ? "transcript available" : "no transcript";
  return `Inbound call ${outcome}; ${hasTranscript}.`;
}

function mapProviderStatus(s: string): CallStatus {
  const v = s.trim().toLowerCase();
  if (v === "completed") return "completed";
  if (v === "no-answer" || v === "no_answer") return "missed";
  if (v === "busy") return "busy";
  if (v === "failed" || v === "canceled" || v === "cancelled") return "failed";
  return "completed";
}

export interface CallStatusResult {
  ok: boolean;
  callId?: string;
  leadId?: string;
  touchId?: string;
  /** true when this status webhook was a duplicate (row already final). */
  duplicate?: boolean;
  minutesBilled?: number;
}

/**
 * Finalize a call from the provider's status callback. Idempotent on the
 * call SID: a second delivery for an already-finalized call returns
 * { duplicate: true } without re-matching the lead or double-logging
 * the touch.
 */
export async function handleCallStatus(input: CallStatusInput): Promise<CallStatusResult> {
  const call = await prisma.call.findUnique({
    where: { externalSid: input.callSid },
    include: { number: true },
  });
  if (!call) return { ok: false };

  const status = mapProviderStatus(input.providerStatus);
  const finalStatuses: CallStatus[] = ["completed", "missed", "voicemail", "busy", "failed"];
  if (call.status !== "in_progress" && finalStatuses.includes(call.status as CallStatus)) {
    return { ok: true, callId: call.id, leadId: call.leadId ?? undefined, duplicate: true };
  }

  const provider = getProvider();
  const durationSec = Math.max(0, Math.floor(input.durationSec ?? 0));
  const recordingUrl = input.recordingUrl ?? null;
  let transcription = input.transcription ?? null;
  if (!transcription && recordingUrl && status === "completed") {
    try {
      const t = await provider.transcribe({ recordingUrl, callSid: input.callSid });
      transcription = t.transcript;
    } catch {
      transcription = null; // transcription is best-effort, never fatal
    }
  }
  const summarizer = input.summaryFn ?? defaultSummarizer;
  const summary = summarizer({ callSid: input.callSid, durationSec, status, transcript: transcription });

  // 2. Lead match-or-create by caller number.
  const { leadId, created } = await matchOrCreateLeadForCall({
    workspaceId: call.workspaceId,
    from: call.from,
    numberCampaign: call.number.campaign,
  });

  // 3. Call-source attribution touch (channel "phone", source
  //    "tracking-number") — hour-dedup makes webhook retries safe.
  const touch = await logTouch({
    workspaceId: call.workspaceId,
    leadId,
    channel: "phone",
    source: "tracking-number",
    campaign: call.number.campaign ?? null,
    touchType: "call",
    occurredAt: call.startedAt,
    meta: {
      call_sid: input.callSid,
      duration_sec: durationSec,
      status,
      number: call.to,
    },
  });

  // 4. Timeline activity on the lead.
  await logActivity({
    workspaceId: call.workspaceId,
    leadId,
    type: "call",
    body: `Inbound call from ${call.from} (${durationSec}s, ${status})${created ? " — new lead created from call" : ""}`,
    actor: "call-tracking",
  });

  const minutesBilled = Math.ceil(durationSec / 60);
  await prisma.call.update({
    where: { id: call.id },
    data: {
      status,
      endedAt: new Date(),
      durationSec,
      recordingUrl,
      transcription,
      summary,
      leadId,
      touchId: touch?.id ?? null,
    },
  });

  // 5. Missed-call text-back (best-effort): only fires when the caller
  // matches a lead with explicit SMS opt-in. A messaging failure must never
  // break call finalization. Dynamic import keeps the module graph acyclic
  // (lib/messaging/consent.ts imports normalizePhone from this module).
  if (status === "missed" && leadId) {
    try {
      const { queueMissedCallTextback } = await import("@/lib/messaging/dispatcher");
      await queueMissedCallTextback({ workspaceId: call.workspaceId, leadId });
    } catch {
      // best-effort — the call row is already finalized above
    }
  }

  return { ok: true, callId: call.id, leadId, touchId: touch?.id ?? undefined, minutesBilled };
}

export interface MatchLeadResult {
  leadId: string;
  created: boolean;
}

/**
 * Find the workspace's lead whose phone matches the caller (last-10-digit
 * match, tolerant of formatting). If none, create a lead with source
 * "phone" — createLeadRecord records the creation touch, so the first
 * attribution touch exists even before the explicit call touch.
 */
export async function matchOrCreateLeadForCall(opts: {
  workspaceId: string;
  from: string;
  numberCampaign?: string | null;
}): Promise<MatchLeadResult> {
  const key = normalizePhone(opts.from);
  if (key) {
    const leads = await prisma.lead.findMany({
      where: { workspaceId: opts.workspaceId, phone: { not: null } },
      select: { id: true, phone: true, updatedAt: true },
      orderBy: { updatedAt: "desc" },
      take: 200,
    });
    const hit = leads.find((l) => normalizePhone(l.phone) === key);
    if (hit) return { leadId: hit.id, created: false };
  }

  // No match (or no usable caller ID): create a lead from the call. The
  // pipeline default is the workspace's first pipeline.
  const pipeline = await prisma.pipeline.findFirst({
    where: { workspaceId: opts.workspaceId },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!pipeline) throw new Error("No pipeline in workspace for call-created lead");

  const last4 = key ? key.slice(-4) : "unknown";
  const res = await createLeadRecord(
    opts.workspaceId,
    "call-tracking",
    {
      pipelineId: pipeline.id,
      name: `Phone caller ••${last4}`,
      phone: opts.from,
      source: "phone",
      campaignFallback: opts.numberCampaign ?? "inbound-call",
    },
  );
  if (!res.ok) throw new Error(`Call lead creation failed: ${res.error}`);
  return { leadId: res.lead.id, created: true };
}
