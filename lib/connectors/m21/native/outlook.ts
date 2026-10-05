// ShapesOS — Phase 11 (conncore): Outlook mail adapter (Microsoft Graph).
//
// LIVE WIRING: with a vault credential (Microsoft identity platform OAuth,
// scopes Mail.Read Mail.Send User.Read offline_access) every tool calls
// Microsoft Graph v1.0 (lib/connectors/m21/live/graph.ts):
//   list_messages     GET  /me/messages
//   get_message       GET  /me/messages/{id} (body as plain text)
//   send_email        POST /me/sendMail                 [mutating]
//   reply_to_message  POST /me/messages/{id}/reply(All) [mutating]
// Mutating tools pass the chat confirmation gate first (connectorAction →
// "send_outreach_email", Tier 2: always asks). Refresh-on-401 goes through
// the vault (InvokeContext.refreshCredential).
//
// MOCK MODE (no credential; dev/test/demo only — production answers "not
// connected", lib/connectors/m21/no-fakes.ts): labelled "(MOCK)" rows and
// mock sends that send nothing. No network calls.

import type {
  ConnectorAdapter,
  ConnectorToolDef,
  DecryptedCredential,
  InvokeContext,
  InvokeResult,
} from "../types";
import { boolProp, fail, liveOk, mockOk, numProp, strProp } from "../types";
import { liveFailure, tokenSourceFrom, type LiveDeps } from "../live/http";
import { graphGetMessage, graphListMessages, graphMe, graphReply, graphSendMail } from "../live/graph";
import { MimeInputError } from "../live/mime";

/** Input-validation errors become bad_request (never a provider error). */
export function inputFailure(err: unknown, provider: string): InvokeResult {
  if (err instanceof MimeInputError || (err instanceof Error && /( is required| must be |Nothing to update)/.test(err.message))) {
    return { ok: false, mock: false, errorCode: "bad_request", error: err.message };
  }
  return liveFailure(err, provider);
}

export class OutlookAdapter implements ConnectorAdapter {
  readonly key = "outlook";
  readonly displayName = "Outlook";
  readonly authType = "oauth2" as const;
  readonly configSchema = { type: "object", properties: {} };

  constructor(private readonly deps: LiveDeps = {}) {}

  listTools(): ConnectorToolDef[] {
    return [
      {
        name: "list_messages",
        description: "List recent Outlook inbox messages (subject, sender, preview), newest first, or search them.",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: {
            search: strProp("Optional search text (subject, body, people)."),
            unreadOnly: boolProp("Only unread messages (ignored with search)."),
            limit: numProp("Max messages (default 25, max 50)."),
          },
        },
      },
      {
        name: "get_message",
        description: "Read one Outlook message (headers and plain-text body) by id.",
        mutating: false,
        argsSchema: { type: "object", properties: { messageId: strProp("Outlook message id.") }, required: ["messageId"] },
      },
      {
        name: "send_email",
        description: "Send an email from the connected Outlook mailbox. Asks for confirmation first.",
        mutating: true,
        argsSchema: {
          type: "object",
          properties: {
            to: strProp("Recipient address(es), comma-separated."),
            cc: strProp("Cc address(es), comma-separated (optional)."),
            subject: strProp("Subject line."),
            body: strProp("Plain-text body."),
            html: strProp("Optional HTML body (sent instead of the plain text)."),
          },
          required: ["to", "subject", "body"],
        },
      },
      {
        name: "reply_to_message",
        description: "Reply in the same Outlook conversation to a message by id. Asks for confirmation first.",
        mutating: true,
        argsSchema: {
          type: "object",
          properties: {
            messageId: strProp("Outlook message id to reply to."),
            body: strProp("Reply text."),
            replyAll: boolProp("Reply to everyone on the message (default false)."),
          },
          required: ["messageId", "body"],
        },
      },
    ];
  }

  async invoke(
    tool: string,
    args: Record<string, unknown>,
    credential: DecryptedCredential | null,
    ctx: InvokeContext,
  ): Promise<InvokeResult> {
    const auth = tokenSourceFrom(credential, ctx);
    if (!auth) return this.mock(tool, args);
    try {
      switch (tool) {
        case "list_messages":
          return liveOk(
            await graphListMessages(
              auth,
              { search: typeof args.search === "string" ? args.search : null, unreadOnly: args.unreadOnly === true, top: Number(args.limit) || 25 },
              this.deps,
            ),
          );
        case "get_message":
          return liveOk(await graphGetMessage(auth, String(args.messageId ?? ""), this.deps));
        case "send_email":
          return liveOk(await graphSendMail(auth, { to: args.to, cc: args.cc, bcc: args.bcc, subject: args.subject, body: args.body, html: args.html }, this.deps));
        case "reply_to_message":
          return liveOk(await graphReply(auth, { messageId: args.messageId, body: args.body, replyAll: args.replyAll }, this.deps));
        default:
          return fail(`Unknown tool "${tool}" for connector ${this.key}`);
      }
    } catch (err) {
      return inputFailure(err, "Outlook");
    }
  }

  async healthCheck(credential: DecryptedCredential, ctx: InvokeContext): Promise<InvokeResult> {
    const auth = tokenSourceFrom(credential, ctx);
    if (!auth) return { ok: false, errorCode: "not_connected", error: "Outlook is not connected." };
    try {
      return liveOk(await graphMe(auth, this.deps));
    } catch (err) {
      return liveFailure(err, "Outlook");
    }
  }

  /** Labelled mock (dev/test/demo). Sends nothing. */
  private mock(tool: string, args: Record<string, unknown>): InvokeResult {
    switch (tool) {
      case "list_messages":
        return mockOk([
          { id: "mock-msg-1", subject: "Quote request (MOCK)", from: "ada@example.com", receivedAt: "2026-10-01T09:00:00Z", preview: "Could you send pricing… (MOCK)", conversationId: "mock-conv-1", isRead: false, mock: true },
        ]);
      case "get_message":
        return mockOk({ id: String(args.messageId ?? "mock-msg-1"), subject: "Quote request (MOCK)", from: "ada@example.com", to: ["you@example.com"], bodyText: "Could you send pricing for next month? (MOCK)", mock: true });
      case "send_email":
        return mockOk({ sent: false, mock: true, info: "MOCK — Outlook is not connected; nothing was sent." });
      case "reply_to_message":
        return mockOk({ sent: false, mock: true, info: "MOCK — Outlook is not connected; nothing was sent." });
      default:
        return fail(`Unknown tool "${tool}" for connector ${this.key}`);
    }
  }
}
