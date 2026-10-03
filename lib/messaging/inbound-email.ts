// ShapesOS — inbound email replies (Phase 4b, CRM conversation inbox).
//
// Outbound email from the messaging dispatcher carries a per-workspace
// Reply-To address when MESSAGING_INBOUND_EMAIL_DOMAIN is set:
//
//     reply+<workspaceId>-<sig>@<domain>
//
// where <sig> is an HMAC of the workspace id (MESSAGING_INBOUND_EMAIL_SECRET),
// so a sender can't drop mail into a workspace by guessing its id. The
// domain's MX points at Resend Inbound; Resend posts an `email.received`
// webhook (metadata only — documented: "Webhooks do not include the email
// body") to POST /api/messaging/inbound/email, and the body is fetched from
// GET https://api.resend.com/emails/receiving/{email_id} with RESEND_API_KEY.
//
// The reply lands in the same ledger as inbound SMS (outbound_message,
// direction "inbound", channel "email"), matched to a lead by the sender's
// address, so it threads in the CRM inbox. Idempotent per Resend email id.

import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { Resend } from "resend";
import { requireSecret } from "@/lib/env/secrets";
import { log } from "@/lib/observability/log";

export const RESEND_RECEIVING_URL = "https://api.resend.com/emails/receiving";
const LOCAL_PREFIX = "reply+";
const SIG_HEX = 16;

export function inboundEmailDomain(env: NodeJS.ProcessEnv = process.env): string | null {
  const d = (env.MESSAGING_INBOUND_EMAIL_DOMAIN ?? "").trim().toLowerCase().replace(/^@/, "");
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : null;
}

function signingSecret(env: NodeJS.ProcessEnv): string {
  return requireSecret("MESSAGING_INBOUND_EMAIL_SECRET", "messaging-inbound-email-dev-secret", env);
}

function sigFor(workspaceId: string, env: NodeJS.ProcessEnv): string {
  return createHmac("sha256", signingSecret(env)).update(`inbound-email:${workspaceId}`).digest("hex").slice(0, SIG_HEX);
}

/** The workspace's Reply-To address, or null when inbound email is off. */
export function replyAddressFor(workspaceId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const domain = inboundEmailDomain(env);
  // Email local parts are case-insensitive in practice: only ids that
  // survive lower-casing (cuids) get an address.
  if (!domain || !/^[a-z0-9_]{1,64}$/.test(workspaceId)) return null;
  return `${LOCAL_PREFIX}${workspaceId}-${sigFor(workspaceId, env)}@${domain}`;
}

/**
 * replyAddressFor for the send path: a misconfiguration (domain set, signing
 * secret missing in production) drops the Reply-To instead of failing the
 * send; the inbound route itself still fails closed.
 */
export function replyAddressForSend(workspaceId: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    return replyAddressFor(workspaceId, env) ?? undefined;
  } catch (e) {
    log.warn("inbound reply address unavailable", { error: e instanceof Error ? e.message : String(e) });
    return undefined;
  }
}

/** "Ada <ada@x.com>" / "ada@x.com" → "ada@x.com" (lower-cased), or null. */
export function extractAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(value) ?? /([^\s<>,;"]+@[^\s<>,;"]+)/.exec(value);
  return m ? m[1]!.trim().toLowerCase() : null;
}

/**
 * The workspace id a reply address belongs to (signature checked in
 * constant time), or null for any other address.
 */
export function workspaceForReplyAddress(address: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const domain = inboundEmailDomain(env);
  const addr = extractAddress(address);
  if (!domain || !addr) return null;
  const at = addr.lastIndexOf("@");
  if (addr.slice(at + 1) !== domain) return null;
  const local = addr.slice(0, at);
  if (!local.startsWith(LOCAL_PREFIX)) return null;
  const rest = local.slice(LOCAL_PREFIX.length);
  const dash = rest.lastIndexOf("-");
  if (dash <= 0) return null;
  const ws = rest.slice(0, dash);
  const sig = rest.slice(dash + 1);
  if (!/^[a-z0-9_]{1,64}$/.test(ws) || sig.length !== SIG_HEX) return null;
  const expected = Buffer.from(sigFor(ws, env));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given) ? ws : null;
}

/** Plain text from an HTML body (good enough for a conversation preview). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Drop the quoted original from a reply: everything from the first
 * "On … wrote:" line, an "-----Original Message-----" divider, or the first
 * run of ">"-quoted lines. Falls back to the full text if that leaves nothing.
 */
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!.trim();
    const outlookHeader = /^From: .+/.test(l) && i > 0 && lines[i - 1]!.trim() === "";
    if (/^On .+wrote:$/i.test(l) || /^-{2,}\s*Original Message\s*-{2,}$/i.test(l) || outlookHeader) {
      cut = i;
      break;
    }
    if (l.startsWith(">")) {
      cut = i;
      break;
    }
  }
  const kept = lines.slice(0, cut).join("\n").trim();
  return kept || text.trim();
}

export interface ReceivedEmailEvent {
  type?: string;
  data?: {
    email_id?: string;
    from?: string;
    to?: string[];
    cc?: string[];
    received_for?: string[];
    subject?: string;
  };
}

export type InboundEmailResult =
  | { action: "logged"; workspaceId: string; leadId: string | null; messageId: string }
  | { action: "duplicate"; workspaceId: string; messageId: string }
  | { action: "ignored"; reason: string };

export class InboundEmailFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboundEmailFetchError";
  }
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

async function fetchBody(emailId: string, env: NodeJS.ProcessEnv, fetchImpl: FetchLike): Promise<{ text: string; subject: string | null }> {
  const key = (env.RESEND_API_KEY ?? "").trim();
  if (!key) throw new InboundEmailFetchError("RESEND_API_KEY is not set; can't fetch the received email body");
  let res: Response;
  try {
    res = await fetchImpl(`${RESEND_RECEIVING_URL}/${encodeURIComponent(emailId)}`, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new InboundEmailFetchError(`Resend receiving API unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new InboundEmailFetchError(`Resend receiving API answered ${res.status}`);
  const j = (await res.json().catch(() => ({}))) as { text?: unknown; html?: unknown; subject?: unknown };
  const raw = typeof j.text === "string" && j.text.trim() ? j.text : typeof j.html === "string" ? htmlToText(j.html) : "";
  return { text: stripQuotedReply(raw), subject: typeof j.subject === "string" ? j.subject : null };
}

/**
 * Handle a verified Resend webhook event. Throws InboundEmailFetchError when
 * the body can't be fetched (the route answers 502 so Resend retries).
 */
export async function handleInboundEmail(
  event: ReceivedEmailEvent,
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: FetchLike } = {},
): Promise<InboundEmailResult> {
  const env = opts.env ?? process.env;
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  if (event?.type !== "email.received") return { action: "ignored", reason: "not an email.received event" };
  const data = event.data ?? {};
  const emailId = typeof data.email_id === "string" ? data.email_id.slice(0, 128) : "";
  if (!emailId) return { action: "ignored", reason: "no email id" };

  const candidates = [...(data.to ?? []), ...(data.cc ?? []), ...(data.received_for ?? [])];
  let workspaceId: string | null = null;
  for (const c of candidates) {
    workspaceId = workspaceForReplyAddress(String(c), env);
    if (workspaceId) break;
  }
  if (!workspaceId) return { action: "ignored", reason: "not addressed to a workspace reply address" };
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } });
  if (!ws) return { action: "ignored", reason: "unknown workspace" };

  const existing = await prisma.outboundMessage.findFirst({
    where: { workspaceId, direction: "inbound", channel: "email", providerSid: emailId },
    select: { id: true },
  });
  if (existing) return { action: "duplicate", workspaceId, messageId: existing.id };

  const content = await fetchBody(emailId, env, fetchImpl);
  const from = extractAddress(data.from);
  const lead = from
    ? await prisma.lead.findFirst({
        where: { workspaceId, email: { equals: from, mode: "insensitive" } },
        orderBy: { updatedAt: "desc" },
        select: { id: true },
      })
    : null;
  const subject = (typeof data.subject === "string" ? data.subject : content.subject ?? "").trim().slice(0, 200) || null;
  const row = await prisma.outboundMessage.create({
    data: {
      workspaceId,
      leadId: lead?.id ?? null,
      channel: "email",
      direction: "inbound",
      kind: "manual",
      subject,
      body: (content.text || "(no text)").slice(0, 5000),
      status: "delivered",
      deliveredAt: new Date(),
      provider: "resend",
      providerSid: emailId,
    },
    select: { id: true },
  });
  if (lead) {
    await prisma.lead
      .update({ where: { id: lead.id }, data: { lastActivityAt: new Date() } })
      .catch(() => {});
  }
  return { action: "logged", workspaceId, leadId: lead?.id ?? null, messageId: row.id };
}

/**
 * Svix signature check for the inbound webhook (Resend signs every webhook
 * with the endpoint's own secret: svix-id / svix-timestamp / svix-signature
 * over the RAW body). Fails closed: no secret → not verified.
 */
export function verifyInboundEmailSignature(
  raw: string,
  headers: Headers,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const secret = (env.RESEND_INBOUND_WEBHOOK_SECRET ?? "").trim();
  if (!secret) return false;
  try {
    new Resend("re_verify_only").webhooks.verify({
      payload: raw,
      headers: {
        id: headers.get("svix-id") ?? "",
        timestamp: headers.get("svix-timestamp") ?? "",
        signature: headers.get("svix-signature") ?? "",
      },
      webhookSecret: secret,
    });
    return true;
  } catch {
    return false;
  }
}
