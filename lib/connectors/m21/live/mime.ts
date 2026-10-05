// ShapesOS — Phase 11 (conncore): a minimal, injection-safe RFC 5322 / MIME
// message builder for connector sends (Gmail users.messages.send takes the
// whole message base64url-encoded in `raw`).
//
// Header values never carry CR/LF (stripped, so a subject or address can't
// add a Bcc: header); non-ASCII subjects use RFC 2047 encoded-words; bodies
// are UTF-8 base64 parts (text/plain, plus text/html as multipart/alternative
// when given). Recipients are validated as plain addr-specs.

import { randomBytes } from "node:crypto";

const ADDR_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
export const MAX_RECIPIENTS = 50;

export class MimeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MimeInputError";
  }
}

/** Strip anything that could end a header line. */
export function headerSafe(value: string): string {
  return value.replace(/[\r\n\u2028\u2029]+/g, " ").trim();
}

/** "a@x.com, B <b@y.com>" or an array → validated bare addresses. */
export function parseRecipients(input: unknown, field: string): string[] {
  const raw: string[] = Array.isArray(input)
    ? input.map(String)
    : typeof input === "string"
      ? input.split(/[,;]/)
      : [];
  const out: string[] = [];
  for (const part of raw) {
    const t = headerSafe(part);
    if (!t) continue;
    const m = t.match(/<([^<>]+)>\s*$/);
    const addr = (m ? m[1] : t).trim().toLowerCase();
    if (!ADDR_RE.test(addr)) throw new MimeInputError(`${field}: "${t.slice(0, 80)}" is not a valid email address.`);
    if (!out.includes(addr)) out.push(addr);
  }
  if (out.length > MAX_RECIPIENTS) throw new MimeInputError(`${field}: at most ${MAX_RECIPIENTS} recipients.`);
  return out;
}

/** RFC 2047 encoded-word for non-ASCII header text. */
export function encodeHeaderText(value: string): string {
  const safe = headerSafe(value);
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(safe)) return safe;
  return `=?UTF-8?B?${Buffer.from(safe, "utf8").toString("base64")}?=`;
}

function b64Lines(text: string): string {
  return (Buffer.from(text, "utf8").toString("base64").match(/.{1,76}/g) ?? [""]).join("\r\n");
}

export interface MimeMessageInput {
  from?: string | null;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string | null;
  /** Message-ID of the message being answered (with angle brackets). */
  inReplyTo?: string | null;
  /** References chain (space-separated Message-IDs). */
  references?: string | null;
}

/** Build the full message (CRLF line endings). */
export function buildMimeMessage(input: MimeMessageInput): string {
  if (input.to.length === 0) throw new MimeInputError("At least one recipient is required.");
  const headers: string[] = [];
  if (input.from) headers.push(`From: ${headerSafe(input.from)}`);
  headers.push(`To: ${input.to.join(", ")}`);
  if (input.cc?.length) headers.push(`Cc: ${input.cc.join(", ")}`);
  if (input.bcc?.length) headers.push(`Bcc: ${input.bcc.join(", ")}`);
  headers.push(`Subject: ${encodeHeaderText(input.subject)}`);
  if (input.inReplyTo) headers.push(`In-Reply-To: ${headerSafe(input.inReplyTo)}`);
  if (input.references) headers.push(`References: ${headerSafe(input.references)}`);
  headers.push("MIME-Version: 1.0");

  const textPart = ["Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", b64Lines(input.text)];
  if (!input.html) {
    return [...headers, ...textPart].join("\r\n");
  }
  const boundary = `shapes_${randomBytes(12).toString("hex")}`;
  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    ...textPart,
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64Lines(input.html),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

export function base64UrlEncode(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

/** "Re: " once (case-insensitive), never "Re: Re:". */
export function replySubject(subject: string): string {
  const s = headerSafe(subject);
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}
