// Marketr — R3 messaging core: consent state machine.
//
// ContactConsent is the per-lead, per-channel consent ledger. The rule is
// absolute: NOTHING is ever sent to a lead whose consent is not "opted_in".
// "unknown" and "pending" both suppress with reason "no_consent"; only an
// explicit opt-in (source recorded) unlocks sending, and any opt-out wins
// over everything that came before it.
//
// Inbound keyword handling (STOP/HELP/START) is the TCPA compliance surface:
// carriers require STOP to opt out within the messaging thread, and the
// opt-out must also suppress anything already queued for that lead+channel.

import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { normalizePhone } from "@/lib/calls/inbound";
import type { ContactConsent } from "@prisma/client";

export type ConsentChannel = "sms" | "email" | "voice" | "mail";
export type ConsentStatus = "unknown" | "pending" | "opted_in" | "opted_out";

const VALID_STATUSES: ConsentStatus[] = ["unknown", "pending", "opted_in", "opted_out"];

/** Current consent status; "unknown" when no row exists yet. */
export async function getConsent(
  workspaceId: string,
  leadId: string,
  channel: ConsentChannel,
): Promise<ConsentStatus> {
  const row = await prisma.contactConsent.findUnique({
    where: { workspaceId_leadId_channel: { workspaceId, leadId, channel } },
    select: { status: true },
  });
  const s = (row?.status ?? "unknown") as ConsentStatus;
  return VALID_STATUSES.includes(s) ? s : "unknown";
}

export async function setConsent(
  workspaceId: string,
  leadId: string,
  channel: ConsentChannel,
  status: ConsentStatus,
  source?: string,
): Promise<ContactConsent> {
  const now = new Date();
  return prisma.contactConsent.upsert({
    where: { workspaceId_leadId_channel: { workspaceId, leadId, channel } },
    create: {
      workspaceId,
      leadId,
      channel,
      status,
      source: source ?? null,
      consentedAt: status === "opted_in" ? now : null,
      optedOutAt: status === "opted_out" ? now : null,
    },
    update: {
      status,
      source: source ?? null,
      // Opting in clears a prior opt-out; opting out clears a prior opt-in.
      consentedAt: status === "opted_in" ? now : status === "opted_out" ? null : undefined,
      optedOutAt: status === "opted_out" ? now : status === "opted_in" ? null : undefined,
    },
  });
}

/** Record an opt-out: status → opted_out, timestamped. Also suppresses any
 * queued (not yet sent) outbound messages for this lead+channel so nothing
 * already in flight goes out after the opt-out lands. */
export async function optOut(
  workspaceId: string,
  leadId: string,
  channel: ConsentChannel,
  source?: string,
): Promise<ContactConsent> {
  const row = await setConsent(workspaceId, leadId, channel, "opted_out", source);
  await prisma.outboundMessage.updateMany({
    where: { workspaceId, leadId, channel, status: "queued" },
    data: { status: "suppressed", suppressionReason: "opt_out" },
  });
  return row;
}

// ---------------------------------------------------------------------------
// Inbound SMS keyword handling (STOP / HELP / START)
// ---------------------------------------------------------------------------

const STOP_KEYWORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);
const START_KEYWORDS = new Set(["start", "yes", "unstop"]);
const HELP_KEYWORDS = new Set(["help", "info"]);

export const HELP_REPLY =
  "Thanks for texting us. Reply STOP to opt out of SMS messages, or START to opt back in. Msg&data rates may apply.";

export interface InboundSmsInput {
  workspaceId: string;
  from: string;
  to: string;
  body: string;
  messageSid?: string;
}

export type InboundSmsAction = "opted_out" | "opted_in" | "help" | "logged";

/**
 * Handle one inbound SMS: log it to the ledger (direction "inbound"),
 * match the sender to a lead by phone, and apply STOP/START keywords to
 * ContactConsent. Returns the action taken so the route can reply to HELP.
 */
export async function handleInboundSms(
  input: InboundSmsInput,
): Promise<{ action: InboundSmsAction; leadId: string | null }> {
  const key = normalizePhone(input.from);
  let leadId: string | null = null;
  if (key) {
    const leads = await prisma.lead.findMany({
      where: { workspaceId: input.workspaceId, phone: { not: null } },
      select: { id: true, phone: true },
      orderBy: { updatedAt: "desc" },
      take: 200,
    });
    leadId = leads.find((l) => normalizePhone(l.phone) === key)?.id ?? null;
  }

  await prisma.outboundMessage.create({
    data: {
      workspaceId: input.workspaceId,
      leadId,
      channel: "sms",
      direction: "inbound",
      kind: "manual",
      body: input.body.slice(0, 2000),
      status: "delivered",
      deliveredAt: new Date(),
      provider: (process.env.MESSAGING_SMS_PROVIDER ?? "fake").trim().toLowerCase(),
      providerSid: input.messageSid ?? null,
    },
  });

  const keyword = input.body.trim().toLowerCase().split(/\s+/)[0] ?? "";
  if (!leadId) return { action: "logged", leadId }; // no lead to attach consent to
  if (STOP_KEYWORDS.has(keyword)) {
    await optOut(input.workspaceId, leadId, "sms", `inbound keyword "${keyword}"`);
    return { action: "opted_out", leadId };
  }
  if (START_KEYWORDS.has(keyword)) {
    await setConsent(input.workspaceId, leadId, "sms", "opted_in", `inbound keyword "${keyword}"`);
    return { action: "opted_in", leadId };
  }
  if (HELP_KEYWORDS.has(keyword)) return { action: "help", leadId };
  return { action: "logged", leadId };
}

// ---------------------------------------------------------------------------
// One-click email unsubscribe tokens
// ---------------------------------------------------------------------------

function unsubscribeSecret(env: NodeJS.ProcessEnv = process.env): string {
  return (env.MESSAGING_UNSUBSCRIBE_SECRET ?? "messaging-unsubscribe-dev-secret").trim();
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** Sign a one-click unsubscribe token bound to one message. */
export function signUnsubscribeToken(
  payload: { workspaceId: string; messageId: string; leadId?: string },
  env: NodeJS.ProcessEnv = process.env,
): string {
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = b64url(createHmac("sha256", unsubscribeSecret(env)).update(body).digest());
  return `${body}.${sig}`;
}

/** Verify a token; returns the payload or null. */
export function verifyUnsubscribeToken(
  token: string,
  env: NodeJS.ProcessEnv = process.env,
): { workspaceId: string; messageId: string; leadId?: string } | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = b64url(createHmac("sha256", unsubscribeSecret(env)).update(body).digest());
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      workspaceId?: string;
      messageId?: string;
      leadId?: string;
    };
    if (typeof payload.workspaceId !== "string" || typeof payload.messageId !== "string") {
      return null;
    }
    return {
      workspaceId: payload.workspaceId,
      messageId: payload.messageId,
      leadId: payload.leadId,
    };
  } catch {
    return null;
  }
}
