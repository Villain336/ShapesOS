// ShapesOS — Phase 11 (conncore): Slack Web API (bot token) calls.
//
//   GET  https://slack.com/api/auth.test                → liveness
//   GET  https://slack.com/api/conversations.list       → channels the bot can see
//   GET  https://slack.com/api/conversations.history    → recent channel messages
//   GET  https://slack.com/api/conversations.replies    → a thread
//   POST https://slack.com/api/chat.postMessage         → post / reply in thread
// Docs: https://docs.slack.dev/reference/methods/chat.postMessage (and siblings)
//
// Slack answers HTTP 200 with { ok: false, error } for most failures, so
// every call checks `ok` and maps the error string onto the closed
// connector error codes. Rate limits arrive as HTTP 429 + Retry-After
// (liveRequest backs off on reads; posts are never retried — a retry could
// post twice). The bot token is a vault credential; it never appears in
// errors (liveRequest scrubs it).

import { ConnectorApiError, liveRequest, type ConnectorErrorCode, type LiveDeps, type TokenSource } from "@/lib/connectors/m21/live/http";

export const SLACK_API = "https://slack.com/api";
const PROVIDER = "Slack";

/** Slack error string → closed connector error code. PURE. */
export function slackErrorCode(error: string): ConnectorErrorCode {
  if (/^(invalid_auth|not_authed|token_revoked|token_expired|account_inactive)$/.test(error)) return "auth_rejected";
  if (/^(missing_scope|not_allowed_token_type|restricted_action|ekm_access_denied|not_in_channel|is_archived|channel_is_archived)$/.test(error)) return "forbidden";
  if (/^(channel_not_found|thread_not_found|message_not_found|user_not_found)$/.test(error)) return "not_found";
  if (error === "ratelimited") return "rate_limited";
  if (/^(internal_error|fatal_error|service_unavailable|request_timeout)$/.test(error)) return "provider_error";
  return "bad_request";
}

interface SlackEnvelope {
  ok?: boolean;
  error?: string;
}

async function slackCall<T extends SlackEnvelope>(
  method: string,
  auth: TokenSource,
  opts: { query?: Record<string, string | number | boolean | undefined>; json?: unknown },
  deps: LiveDeps,
): Promise<T> {
  const res = await liveRequest<T>(
    {
      provider: PROVIDER,
      url: `${SLACK_API}/${method}`,
      method: opts.json === undefined ? "GET" : "POST",
      query: opts.query,
      json: opts.json,
      headers: opts.json === undefined ? undefined : { "Content-Type": "application/json; charset=utf-8" },
      auth,
    },
    deps,
  );
  if (!res || res.ok !== true) {
    const error = String(res?.error ?? "unknown_error").slice(0, 80);
    throw new ConnectorApiError(PROVIDER, slackErrorCode(error), `Slack ${method} failed: ${error}`);
  }
  return res;
}

const CHANNEL_RE = /^[CGD][A-Z0-9]{6,20}$/;
const TS_RE = /^\d{9,11}\.\d{1,8}$/;

export function channelIdOf(v: unknown): string {
  const id = typeof v === "string" ? v.trim() : "";
  if (!CHANNEL_RE.test(id)) throw new Error("channel must be a Slack channel id like C0123ABC.");
  return id;
}

export function tsOf(v: unknown, field = "threadTs"): string {
  const ts = typeof v === "string" ? v.trim() : "";
  if (!TS_RE.test(ts)) throw new Error(`${field} must be a Slack message ts like 1712345678.000100.`);
  return ts;
}

export interface SlackChannel {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
  topic: string | null;
}

export interface SlackMessage {
  ts: string;
  user: string | null;
  text: string;
  threadTs: string | null;
  replyCount: number;
  bot: boolean;
}

interface RawMessage {
  ts?: string;
  user?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  bot_id?: string;
  subtype?: string;
}

const toMessage = (m: RawMessage): SlackMessage => ({
  ts: String(m.ts ?? ""),
  user: m.user ?? null,
  text: String(m.text ?? "").slice(0, 4000),
  threadTs: m.thread_ts ?? null,
  replyCount: Number(m.reply_count ?? 0),
  bot: Boolean(m.bot_id) || m.subtype === "bot_message",
});

export async function slackAuthTest(auth: TokenSource, deps: LiveDeps = {}): Promise<{ teamId: string; team: string; botUserId: string | null }> {
  const r = await slackCall<SlackEnvelope & { team_id?: string; team?: string; user_id?: string }>("auth.test", auth, {}, deps);
  return { teamId: String(r.team_id ?? ""), team: String(r.team ?? ""), botUserId: r.user_id ?? null };
}

export async function slackListChannels(auth: TokenSource, opts: { limit?: number } = {}, deps: LiveDeps = {}): Promise<SlackChannel[]> {
  const out: SlackChannel[] = [];
  const max = Math.min(Math.max(Math.floor(opts.limit ?? 200), 1), 1000);
  let cursor: string | undefined;
  do {
    const r = await slackCall<SlackEnvelope & {
      channels?: Array<{ id?: string; name?: string; is_private?: boolean; is_member?: boolean; topic?: { value?: string } }>;
      response_metadata?: { next_cursor?: string };
    }>(
      "conversations.list",
      auth,
      { query: { types: "public_channel,private_channel", exclude_archived: true, limit: Math.min(200, max - out.length), cursor } },
      deps,
    );
    for (const c of r.channels ?? []) {
      out.push({ id: String(c.id ?? ""), name: String(c.name ?? ""), isPrivate: c.is_private === true, isMember: c.is_member === true, topic: c.topic?.value || null });
    }
    cursor = r.response_metadata?.next_cursor || undefined;
  } while (cursor && out.length < max);
  return out;
}

export async function slackReadMessages(
  auth: TokenSource,
  opts: { channel: unknown; threadTs?: unknown; limit?: number },
  deps: LiveDeps = {},
): Promise<SlackMessage[]> {
  const channel = channelIdOf(opts.channel);
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 30), 1), 200);
  if (opts.threadTs !== undefined && opts.threadTs !== null && opts.threadTs !== "") {
    const r = await slackCall<SlackEnvelope & { messages?: RawMessage[] }>(
      "conversations.replies",
      auth,
      { query: { channel, ts: tsOf(opts.threadTs), limit } },
      deps,
    );
    return (r.messages ?? []).map(toMessage);
  }
  const r = await slackCall<SlackEnvelope & { messages?: RawMessage[] }>("conversations.history", auth, { query: { channel, limit } }, deps);
  return (r.messages ?? []).map(toMessage);
}

/** Post a message (optionally as a thread reply). Never retried. */
export async function slackPostMessage(
  auth: TokenSource,
  opts: { channel: unknown; text: unknown; threadTs?: unknown },
  deps: LiveDeps = {},
): Promise<{ channel: string; ts: string }> {
  const channel = channelIdOf(opts.channel);
  const text = typeof opts.text === "string" ? opts.text.trim() : "";
  if (!text) throw new Error("text is required.");
  const thread = opts.threadTs !== undefined && opts.threadTs !== null && opts.threadTs !== "" ? tsOf(opts.threadTs) : undefined;
  const r = await slackCall<SlackEnvelope & { channel?: string; ts?: string }>(
    "chat.postMessage",
    auth,
    // Slack caps text at 40k chars; keep well under it. No link unfurls of
    // agent output (they would fetch arbitrary URLs from Slack's side).
    { json: { channel, text: text.slice(0, 35_000), ...(thread ? { thread_ts: thread } : {}), unfurl_links: false, unfurl_media: false } },
    { ...deps, maxRetries: 0 },
  );
  return { channel: String(r.channel ?? channel), ts: String(r.ts ?? "") };
}
