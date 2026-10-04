// ShapesOS — Phase 11 (conncore): Gmail send + reply-in-thread (live).
//
//   POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send
//        { raw: base64url(RFC 5322 message), threadId? }      (scope gmail.send)
//   GET  https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}
//        ?format=metadata&metadataHeaders=…                   (scope gmail.readonly)
//        → the original's threadId + Message-ID / References / Subject /
//          From / Reply-To, so the reply threads in Gmail and in the
//          recipient's client (In-Reply-To + References, "Re:" subject).
// Docs: https://developers.google.com/workspace/gmail/api/guides/sending
//       https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send
//
// Sends are NOT retried on 5xx/network errors (a retry could send twice);
// liveRequest still refreshes once on 401. Reaching this code at all needs
// the chat confirmation gate (gmail.send_email is a mutating tool that maps
// to the Tier-2 "send_outreach_email" action — it always asks).

import { liveRequest, type LiveDeps, type TokenSource } from "./http";
import { base64UrlEncode, buildMimeMessage, headerSafe, parseRecipients, replySubject } from "./mime";

export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const PROVIDER = "Gmail";
const MAX_BODY = 200_000;

export interface GmailSendInput {
  to: unknown;
  cc?: unknown;
  bcc?: unknown;
  subject: unknown;
  body: unknown;
  html?: unknown;
}

export interface GmailSent {
  id: string;
  threadId: string;
}

function text(v: unknown, field: string, max = MAX_BODY): string {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${field} is required.`);
  return v.length > max ? v.slice(0, max) : v;
}

/** No retries for the send itself (never risk a double send). */
function sendDeps(deps: LiveDeps): LiveDeps {
  return { ...deps, maxRetries: 0 };
}

export async function gmailSend(auth: TokenSource, input: GmailSendInput, deps: LiveDeps = {}): Promise<GmailSent> {
  const raw = buildMimeMessage({
    to: parseRecipients(input.to, "to"),
    cc: parseRecipients(input.cc, "cc"),
    bcc: parseRecipients(input.bcc, "bcc"),
    subject: text(input.subject, "subject", 998),
    text: text(input.body, "body"),
    html: typeof input.html === "string" && input.html.trim() ? input.html.slice(0, MAX_BODY) : null,
  });
  const res = await liveRequest<{ id?: string; threadId?: string }>(
    { provider: PROVIDER, url: `${GMAIL_API}/messages/send`, method: "POST", json: { raw: base64UrlEncode(raw) }, auth },
    sendDeps(deps),
  );
  return { id: String(res?.id ?? ""), threadId: String(res?.threadId ?? "") };
}

interface MetadataMessage {
  id?: string;
  threadId?: string;
  payload?: { headers?: Array<{ name: string; value: string }> };
}

function header(msg: MetadataMessage, name: string): string {
  const h = msg.payload?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

/** Reply to a message in its own thread (Re: subject, In-Reply-To/References). */
export async function gmailReply(
  auth: TokenSource,
  input: { messageId: unknown; body: unknown; html?: unknown; replyAll?: unknown },
  deps: LiveDeps = {},
): Promise<GmailSent & { to: string[] }> {
  const messageId = typeof input.messageId === "string" ? input.messageId.trim() : "";
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(messageId)) throw new Error("messageId must be a Gmail message id.");
  const url = new URL(`${GMAIL_API}/messages/${messageId}`);
  url.searchParams.set("format", "metadata");
  for (const h of ["Message-ID", "References", "Subject", "From", "Reply-To", "To", "Cc"]) url.searchParams.append("metadataHeaders", h);
  const original = await liveRequest<MetadataMessage>({ provider: PROVIDER, url: url.toString(), auth }, deps);

  const replyTo = header(original, "Reply-To") || header(original, "From");
  const to = parseRecipients(replyTo, "to");
  const cc = input.replyAll === true || input.replyAll === "true"
    ? parseRecipients(`${header(original, "To")},${header(original, "Cc")}`, "cc").filter((a) => !to.includes(a))
    : [];
  const origId = headerSafe(header(original, "Message-ID"));
  const refs = [headerSafe(header(original, "References")), origId].filter(Boolean).join(" ");
  const raw = buildMimeMessage({
    to,
    cc,
    subject: replySubject(header(original, "Subject") || "(no subject)"),
    text: text(input.body, "body"),
    html: typeof input.html === "string" && input.html.trim() ? input.html.slice(0, MAX_BODY) : null,
    inReplyTo: origId || null,
    references: refs || null,
  });
  const res = await liveRequest<{ id?: string; threadId?: string }>(
    {
      provider: PROVIDER,
      url: `${GMAIL_API}/messages/send`,
      method: "POST",
      json: { raw: base64UrlEncode(raw), ...(original.threadId ? { threadId: original.threadId } : {}) },
      auth,
    },
    sendDeps(deps),
  );
  return { id: String(res?.id ?? ""), threadId: String(res?.threadId ?? original.threadId ?? ""), to };
}

/** Cheap liveness: the profile of the connected mailbox. */
export async function gmailProfile(auth: TokenSource, deps: LiveDeps = {}): Promise<{ emailAddress: string }> {
  const res = await liveRequest<{ emailAddress?: string }>({ provider: PROVIDER, url: `${GMAIL_API}/profile`, auth }, deps);
  return { emailAddress: String(res?.emailAddress ?? "") };
}
