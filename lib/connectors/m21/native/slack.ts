// ShapesOS — Phase 11 (conncore): Slack adapter (the full Slack app).
//
// LIVE WIRING: Slack OAuth v2 installs the ShapesOS app into a Slack team;
// the bot token (xoxb-…) is the vault credential of the "slack" connection
// (lib/vault/oauth.ts; the install also records the team for the Events API
// in slack_installations — lib/slack/install.ts). Tools call the Slack Web
// API (lib/slack/api.ts):
//   list_channels    conversations.list
//   read_messages    conversations.history / conversations.replies
//   post_message     chat.postMessage            [mutating]
//   reply_in_thread  chat.postMessage(thread_ts) [mutating]
// Mutating tools pass the chat confirmation gate (default Tier-2
// connector_write: always asks). Inbound: a mention of the bot starts an
// agent task (POST /api/hooks/slack/events → lib/slack/events.ts).
//
// MOCK MODE (no credential; dev/test/demo only — production answers "not
// connected"): labelled "(MOCK)" channels/messages; mock posts post nothing.

import type {
  ConnectorAdapter,
  ConnectorToolDef,
  DecryptedCredential,
  InvokeContext,
  InvokeResult,
} from "../types";
import { fail, liveOk, mockOk, numProp, strProp } from "../types";
import { liveFailure, tokenSourceFrom, type LiveDeps } from "../live/http";
import { slackAuthTest, slackListChannels, slackPostMessage, slackReadMessages } from "@/lib/slack/api";
import { inputFailure } from "./outlook";

export class SlackAdapter implements ConnectorAdapter {
  readonly key = "slack";
  readonly displayName = "Slack";
  readonly authType = "oauth2" as const;
  readonly configSchema = { type: "object", properties: {} };

  constructor(private readonly deps: LiveDeps = {}) {}

  listTools(): ConnectorToolDef[] {
    return [
      {
        name: "list_channels",
        description: "List Slack channels the ShapesOS app can see (id, name, private, whether the bot is a member).",
        mutating: false,
        argsSchema: { type: "object", properties: { limit: numProp("Max channels (default 200).") } },
      },
      {
        name: "read_messages",
        description: "Read recent messages in a Slack channel, or one thread when threadTs is given. The bot must be in the channel.",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: {
            channel: strProp("Channel id (C…/G…)."),
            threadTs: strProp("Thread root ts to read one thread (optional)."),
            limit: numProp("Max messages (default 30)."),
          },
          required: ["channel"],
        },
      },
      {
        name: "post_message",
        description: "Post a message to a Slack channel. Asks for confirmation first.",
        mutating: true,
        argsSchema: {
          type: "object",
          properties: { channel: strProp("Channel id (C…/G…)."), text: strProp("Message text (Slack mrkdwn).") },
          required: ["channel", "text"],
        },
      },
      {
        name: "reply_in_thread",
        description: "Reply inside a Slack thread. Asks for confirmation first.",
        mutating: true,
        argsSchema: {
          type: "object",
          properties: {
            channel: strProp("Channel id (C…/G…)."),
            threadTs: strProp("Thread root ts."),
            text: strProp("Reply text (Slack mrkdwn)."),
          },
          required: ["channel", "threadTs", "text"],
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
        case "list_channels":
          return liveOk(await slackListChannels(auth, { limit: Number(args.limit) || undefined }, this.deps));
        case "read_messages":
          return liveOk(await slackReadMessages(auth, { channel: args.channel, threadTs: args.threadTs, limit: Number(args.limit) || undefined }, this.deps));
        case "post_message":
          return liveOk(await slackPostMessage(auth, { channel: args.channel, text: args.text }, this.deps));
        case "reply_in_thread":
          if (!args.threadTs) return { ok: false, mock: false, errorCode: "bad_request", error: "threadTs is required." };
          return liveOk(await slackPostMessage(auth, { channel: args.channel, text: args.text, threadTs: args.threadTs }, this.deps));
        default:
          return fail(`Unknown tool "${tool}" for connector ${this.key}`);
      }
    } catch (err) {
      return inputFailure(err, "Slack");
    }
  }

  async healthCheck(credential: DecryptedCredential, ctx: InvokeContext): Promise<InvokeResult> {
    const auth = tokenSourceFrom(credential, ctx);
    if (!auth) return { ok: false, errorCode: "not_connected", error: "Slack is not connected." };
    try {
      return liveOk(await slackAuthTest(auth, this.deps));
    } catch (err) {
      return liveFailure(err, "Slack");
    }
  }

  private mock(tool: string, args: Record<string, unknown>): InvokeResult {
    switch (tool) {
      case "list_channels":
        return mockOk([{ id: "C0MOCK001", name: "general (MOCK)", isPrivate: false, isMember: true, topic: null, mock: true }]);
      case "read_messages":
        return mockOk([{ ts: "1700000000.000100", user: "U0MOCK", text: "Can someone draft the launch post? (MOCK)", threadTs: null, replyCount: 0, bot: false, mock: true }]);
      case "post_message":
      case "reply_in_thread":
        return mockOk({ posted: false, mock: true, channel: String(args.channel ?? ""), info: "MOCK — Slack is not connected; nothing was posted." });
      default:
        return fail(`Unknown tool "${tool}" for connector ${this.key}`);
    }
  }
}
