// Marketr — M21 Gmail adapter (Connector Agent slice 2).
//
// LIVE WIRING: this adapter calls the Gmail API v3 with the tenant's
// OAuth2 bearer token (scope gmail.readonly, granted via the vault OAuth
// flow). It fetches MESSAGE METADATA ONLY — From/To/Cc/Date headers.
// Message bodies and snippets are never requested, never stored.
//
//   GET https://gmail.googleapis.com/gmail/v1/users/me/profile
//     → the tenant's own address (excluded from contacts; sets direction)
//   GET https://gmail.googleapis.com/gmail/v1/users/me/messages
//     ?q=…&maxResults=…&pageToken=… → message ids (newest first)
//   GET https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}
//     ?format=metadata&metadataHeaders=From,To,Cc,Date → participants
//
// Direction is relative to the tenant: a message FROM the tenant is an
// outbound touch with every recipient; a message TO the tenant is an
// inbound touch from the sender (other To/Cc recipients on inbound mail
// are not counted — they are not a touch with the tenant).
//
// Rate bounds: max 500 messages per call, metadata fetched sequentially.
// Auth: OAuth2 Bearer <redacted> refresh via lib/vault/refresh.ts.
//
// Phase 18.2 (WS=comms): list_threads / get_thread (scope gmail.readonly,
// already granted) serve the Mail app: thread HEADERS are cached for
// listing, message bodies are returned only for the thread being opened and
// never stored (lib/connectors/m21/live/gmail-read.ts). Reads only.
//
// Phase 11 (conncore): send_email and reply_to_message (scope gmail.send)
// are MUTATING tools — the chat confirmation gate asks before each one
// (connectorAction → "send_outreach_email", Tier 2: always asks). The live
// calls are in lib/connectors/m21/live/gmail.ts. Without a credential the
// tools fail "not connected" (no mock send exists).

import type {
  ConnectorAdapter,
  ConnectorToolDef,
  DecryptedCredential,
  InvokeContext,
  InvokeResult,
} from "../types";
import { boolProp, fail, liveOk, strProp } from "../types";
import { liveFailure, tokenSourceFrom, type LiveDeps } from "../live/http";
import { gmailProfile, gmailReply, gmailSend } from "../live/gmail";
import { gmailGetThread, gmailListThreads } from "../live/gmail-read";
import { MimeInputError } from "../live/mime";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_MESSAGES_HARD_CAP = 500;
const LOOKBACK_DEFAULT = "newer_than:2y";

export interface GmailNetworkContact {
  email: string;
  name: string | null;
  interactionCount: number;
  inboundCount: number;
  outboundCount: number;
  /** ISO date of the newest interaction. */
  lastInteractionAt: string | null;
}

export interface GmailNetworkResult {
  contacts: GmailNetworkContact[];
  /** ISO date of the newest message processed — the import cursor. */
  cursor: string | null;
  ownEmail: string;
}

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

function extractEmails(header: string): string[] {
  const out: string[] = [];
  for (const m of header.matchAll(EMAIL_RE)) out.push(m[0].toLowerCase());
  return out;
}

function displayNameFor(header: string, email: string): string | null {
  // "Ada Lovelace <ada@x.com>" → "Ada Lovelace"; bare "ada@x.com" → null.
  const idx = header.toLowerCase().indexOf(email);
  if (idx <= 0) return null;
  const raw = header.slice(0, idx).trim().replace(/[<\s"]+$/g, "").replace(/^["\s]+/g, "");
  return raw || null;
}

function headerValue(headers: Array<{ name: string; value: string }>, name: string): string {
  const h = headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

async function gmailFetch(
  path: string,
  token: string,
  params: Record<string, string> = {},
): Promise<unknown> {
  const url = new URL(`${GMAIL_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    // Never leak the token or body in the error; the engine maps this to
    // a needs_reauth hint via the connection status.
    throw new Error(`Gmail API request failed (HTTP ${res.status})`);
  }
  return res.json() as Promise<unknown>;
}

export class GmailAdapter implements ConnectorAdapter {
  readonly key = "gmail";
  readonly displayName = "Gmail";
  readonly authType = "oauth2" as const;
  readonly configSchema = {
    type: "object",
    properties: {},
  };

  constructor(private readonly deps: LiveDeps = {}) {}

  listTools(): ConnectorToolDef[] {
    return [
      // Phase 11 (conncore): gated writes.
      {
        name: "send_email",
        description:
          "Send an email from the connected Gmail account. Plain-text body (optional HTML alternative). Asks for confirmation first.",
        mutating: true,
        argsSchema: {
          type: "object",
          properties: {
            to: strProp("Recipient address(es), comma-separated."),
            cc: strProp("Cc address(es), comma-separated (optional)."),
            subject: strProp("Subject line."),
            body: strProp("Plain-text body."),
            html: strProp("Optional HTML version of the body."),
          },
          required: ["to", "subject", "body"],
        },
      },
      {
        name: "reply_to_message",
        description:
          "Reply in the same Gmail thread to a message (by Gmail message id): Re: subject, threaded headers. Asks for confirmation first.",
        mutating: true,
        argsSchema: {
          type: "object",
          properties: {
            messageId: strProp("Gmail message id to reply to."),
            body: strProp("Plain-text reply body."),
            replyAll: boolProp("Also copy the original To/Cc recipients (default false)."),
          },
          required: ["messageId", "body"],
        },
      },
      // Phase 18.2 (WS=comms): the Mail app's reads.
      {
        name: "list_threads",
        description: "List recent Gmail threads (subject, people, date, labels, unread), newest first; optional Gmail search query.",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: {
            q: strProp("Optional Gmail search, e.g. \"in:inbox newer_than:7d\"."),
            labelIds: strProp("Optional label id, e.g. INBOX."),
            maxResults: strProp("Max threads (default 25, max 50)."),
            pageToken: strProp("Next page token from a previous call."),
          },
        },
      },
      {
        name: "get_thread",
        description: "Read one Gmail thread: every message's headers and plain-text body, oldest first. Nothing is stored.",
        mutating: false,
        argsSchema: { type: "object", properties: { threadId: strProp("Gmail thread id (from list_threads).") }, required: ["threadId"] },
      },
      {
        name: "list_network_contacts",
        description:
          "Aggregate the tenant's email network from message metadata (From/To/Cc/Date). Message bodies are never read. Returns per-contact interaction counts, direction, and an import cursor.",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: {
            since: strProp(
              "ISO date — only messages newer than this are scanned (incremental sync).",
            ),
            maxMessages: strProp("Max messages to scan (default 100, hard cap 500)."),
          },
        },
      },
    ];
  }

  async invoke(
    tool: string,
    args: Record<string, unknown>,
    credential: DecryptedCredential | null,
    _ctx: InvokeContext,
  ): Promise<InvokeResult> {
    if (tool === "send_email" || tool === "reply_to_message") {
      return this.write(tool, args, credential, _ctx);
    }
    if (tool === "list_threads" || tool === "get_thread") {
      const auth = tokenSourceFrom(credential, _ctx);
      if (!auth) return { ok: false, mock: false, errorCode: "not_connected", error: "Gmail is not connected. Connect Gmail to read your mail here." };
      try {
        if (tool === "list_threads") {
          return liveOk(
            await gmailListThreads(
              auth,
              { q: typeof args.q === "string" ? args.q.slice(0, 500) : null, labelIds: typeof args.labelIds === "string" ? args.labelIds.slice(0, 100) : null, max: Number(args.maxResults) || 25, pageToken: typeof args.pageToken === "string" ? args.pageToken : null },
              this.deps,
            ),
          );
        }
        return liveOk(await gmailGetThread(auth, String(args.threadId ?? ""), this.deps));
      } catch (err) {
        if (err instanceof Error && / must be /.test(err.message)) return { ok: false, mock: false, errorCode: "bad_request", error: err.message };
        return liveFailure(err, "Gmail");
      }
    }
    if (tool !== "list_network_contacts") {
      return fail(`Unknown tool "${tool}" for the Gmail connector.`);
    }
    const token =
      credential?.kind === "oauth2" && typeof credential.payload.access_token === "string"
        ? (credential.payload.access_token as string)
        : null;
    if (!token) {
      return fail(
        "Gmail is not connected. Connect Gmail first so the connector can read message metadata.",
      );
    }
    const maxMessages = Math.min(
      Math.max(Number(args.maxMessages) || 100, 1),
      MAX_MESSAGES_HARD_CAP,
    );
    const since = typeof args.since === "string" && args.since ? new Date(args.since) : null;
    const sinceValid = since && !Number.isNaN(since.getTime()) ? since : null;

    try {
      const profile = (await gmailFetch("/profile", token)) as {
        emailAddress?: string;
      };
      const ownEmail = (profile.emailAddress ?? "").toLowerCase();
      if (!ownEmail) return fail("Gmail did not return a profile email address.");

      // Gmail search supports after:YYYY/M/D — the incremental path.
      const q = sinceValid
        ? `after:${sinceValid.getUTCFullYear()}/${sinceValid.getUTCMonth() + 1}/${sinceValid.getUTCDate()}`
        : LOOKBACK_DEFAULT;

      const messageIds: string[] = [];
      let pageToken: string | undefined;
      while (messageIds.length < maxMessages) {
        const page = (await gmailFetch("/messages", token, {
          q,
          maxResults: String(Math.min(100, maxMessages - messageIds.length)),
          ...(pageToken ? { pageToken } : {}),
        })) as { messages?: Array<{ id: string }>; nextPageToken?: string };
        for (const m of page.messages ?? []) messageIds.push(m.id);
        pageToken = page.nextPageToken;
        if (!pageToken) break;
      }

      const contacts = new Map<string, GmailNetworkContact>();
      let newest: Date | null = null;
      for (const id of messageIds) {
        const full = (await gmailFetch(`/messages/${id}`, token, {
          format: "metadata",
          metadataHeaders: "From,To,Cc,Date",
        })) as {
          payload?: { headers?: Array<{ name: string; value: string }> };
        };
        const headers = full.payload?.headers ?? [];
        const fromHeader = headerValue(headers, "From");
        const fromEmails = extractEmails(fromHeader);
        const date = new Date(headerValue(headers, "Date"));
        const dateValid = !Number.isNaN(date.getTime());
        if (dateValid && (!newest || date > newest)) newest = date;
        // Incremental guard: the after: filter is day-granular; drop any
        // stragglers at or before the exact cursor.
        if (sinceValid && (!dateValid || date.getTime() <= sinceValid.getTime())) continue;

        const fromMe = fromEmails.includes(ownEmail);
        const recipients = new Set<string>();
        for (const h of ["To", "Cc"]) {
          for (const e of extractEmails(headerValue(headers, h))) {
            if (e !== ownEmail) recipients.add(e);
          }
        }

        const touch = (
          email: string,
          header: string,
          direction: "inbound" | "outbound",
        ) => {
          const existing = contacts.get(email);
          const name =
            existing?.name ?? displayNameFor(header, email);
          const row: GmailNetworkContact = existing ?? {
            email,
            name: null,
            interactionCount: 0,
            inboundCount: 0,
            outboundCount: 0,
            lastInteractionAt: null,
          };
          row.name = name;
          row.interactionCount += 1;
          if (direction === "inbound") row.inboundCount += 1;
          else row.outboundCount += 1;
          if (dateValid) {
            const iso = date.toISOString();
            if (!row.lastInteractionAt || iso > row.lastInteractionAt) {
              row.lastInteractionAt = iso;
            }
          }
          contacts.set(email, row);
        };

        if (fromMe) {
          const toHeader = `${headerValue(headers, "To")} ${headerValue(headers, "Cc")}`;
          for (const email of recipients) touch(email, toHeader, "outbound");
        } else {
          // Inbound: only the sender is a touch with the tenant.
          for (const email of fromEmails) {
            if (email !== ownEmail) touch(email, fromHeader, "inbound");
          }
        }
      }

      const result: GmailNetworkResult = {
        contacts: [...contacts.values()],
        cursor: newest ? newest.toISOString() : null,
        ownEmail,
      };
      return liveOk(result);
    } catch (err) {
      return fail(err instanceof Error ? err.message : "Gmail import failed.");
    }
  }

  /** Phase 11 (conncore): send / reply (gated upstream by the confirmation gate). */
  private async write(
    tool: "send_email" | "reply_to_message",
    args: Record<string, unknown>,
    credential: DecryptedCredential | null,
    ctx: InvokeContext,
  ): Promise<InvokeResult> {
    const auth = tokenSourceFrom(credential, ctx);
    if (!auth) {
      return { ok: false, mock: false, errorCode: "not_connected", error: "Gmail is not connected. Connect Gmail to send email." };
    }
    try {
      if (tool === "send_email") {
        return liveOk(await gmailSend(auth, { to: args.to, cc: args.cc, bcc: args.bcc, subject: args.subject, body: args.body, html: args.html }, this.deps));
      }
      return liveOk(await gmailReply(auth, { messageId: args.messageId, body: args.body, html: args.html, replyAll: args.replyAll }, this.deps));
    } catch (err) {
      if (err instanceof MimeInputError || (err instanceof Error && / is required\.$| must be /.test(err.message))) {
        return { ok: false, mock: false, errorCode: "bad_request", error: err.message };
      }
      return liveFailure(err, "Gmail");
    }
  }

  async healthCheck(credential: DecryptedCredential, ctx: InvokeContext): Promise<InvokeResult> {
    const auth = tokenSourceFrom(credential, ctx);
    if (!auth) return { ok: false, errorCode: "not_connected", error: "Gmail is not connected." };
    try {
      return liveOk(await gmailProfile(auth, this.deps));
    } catch (err) {
      return liveFailure(err, "Gmail");
    }
  }
}
