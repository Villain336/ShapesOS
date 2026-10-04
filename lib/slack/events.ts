// ShapesOS — Phase 11 (conncore): the Slack Events API receiver.
//
// POST /api/hooks/slack/events (app/api/hooks/slack/events/route.ts) hands
// the raw body and two headers here. In order, before any write:
//   1. SLACK_SIGNING_SECRET must be set (else 503: the receiver is off);
//   2. X-Slack-Signature = "v0=" + hex HMAC-SHA256(secret, "v0:" + ts + ":" +
//      raw body), checked in constant time, with X-Slack-Request-Timestamp
//      within 5 minutes (replay window) — else 401;
//   3. url_verification answers the challenge (Slack's endpoint check);
//   4. the event is classified: app_mention, or a direct message to the bot
//      (message.im) from a person — bots, edits, joins and anything else are
//      acknowledged and ignored (never steer an agent from a bot);
//   5. team_id is routed to its installation (routeSlackTeam: the one
//      cross-tenant SELECT) — unknown or disabled → 200 ignored;
//   6. the event id is stored once (slack_event_receipts primary key: a
//      Slack retry is a duplicate and does nothing) and ONE `slack_mention`
//      agent job is queued; the job (lib/slack/mention.ts) runs the turn in
//      the Slack thread's chat thread and replies in Slack.
// Responses carry counts and reasons only — never workspace data.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { SlackInstallRow } from "./install";
import { agentWorkerMode } from "@/lib/agents/queue/config";

export const SLACK_SIGNATURE_HEADER = "x-slack-signature";
export const SLACK_TIMESTAMP_HEADER = "x-slack-request-timestamp";
export const SLACK_EVENTS_MAX_BYTES = 1024 * 1024;
const REPLAY_WINDOW_S = 5 * 60;

/** Slack v0 request signing. PURE. */
export function verifySlackSignature(
  secret: string,
  rawBody: string,
  timestamp: string | null,
  signature: string | null,
  nowMs = Date.now(),
): { ok: boolean; reason?: string } {
  if (!signature || !signature.startsWith("v0=")) return { ok: false, reason: "missing or malformed X-Slack-Signature" };
  if (!timestamp || !/^\d{9,11}$/.test(timestamp)) return { ok: false, reason: "missing X-Slack-Request-Timestamp" };
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > REPLAY_WINDOW_S) return { ok: false, reason: "timestamp outside the 5-minute window" };
  const expected = "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`, "utf8").digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: "signature mismatch" };
}

/** Sign a body the way Slack does (tests and local tooling). */
export function signSlackRequest(secret: string, rawBody: string, timestamp: string): string {
  return "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`, "utf8").digest("hex");
}

export interface SlackMention {
  eventId: string;
  teamId: string;
  eventType: "app_mention" | "message.im";
  channel: string;
  /** The Slack user who wrote the message. */
  user: string;
  /** The message's own ts. */
  ts: string;
  /** Root of the Slack thread the reply goes into (thread_ts, or ts for a new thread). */
  threadTs: string;
  /** Message text with bot mentions removed. */
  text: string;
}

export type Classified =
  | { kind: "url_verification"; challenge: string }
  | { kind: "mention"; mention: SlackMention }
  | { kind: "ignore"; reason: string };

/** Classify a parsed Events API body. PURE. */
export function classifySlackEvent(body: unknown): Classified {
  if (!body || typeof body !== "object") return { kind: "ignore", reason: "not an object" };
  const b = body as Record<string, unknown>;
  if (b.type === "url_verification") {
    const challenge = typeof b.challenge === "string" ? b.challenge.slice(0, 200) : "";
    return challenge ? { kind: "url_verification", challenge } : { kind: "ignore", reason: "no challenge" };
  }
  if (b.type !== "event_callback") return { kind: "ignore", reason: `unhandled type ${String(b.type).slice(0, 40)}` };
  const ev = (b.event ?? {}) as Record<string, unknown>;
  const eventId = typeof b.event_id === "string" ? b.event_id : "";
  const teamId = typeof b.team_id === "string" ? b.team_id : typeof ev.team === "string" ? ev.team : "";
  if (!/^Ev[A-Za-z0-9]{6,40}$/.test(eventId)) return { kind: "ignore", reason: "no event id" };
  if (!teamId) return { kind: "ignore", reason: "no team id" };
  // Never let a bot (including ourselves) steer an agent; skip edits/joins.
  if (ev.bot_id || ev.subtype) return { kind: "ignore", reason: "bot or non-message subtype" };
  let eventType: SlackMention["eventType"];
  if (ev.type === "app_mention") eventType = "app_mention";
  else if (ev.type === "message" && ev.channel_type === "im") eventType = "message.im";
  else return { kind: "ignore", reason: `unhandled event ${String(ev.type).slice(0, 40)}` };
  const channel = typeof ev.channel === "string" ? ev.channel : "";
  const user = typeof ev.user === "string" ? ev.user : "";
  const ts = typeof ev.ts === "string" ? ev.ts : "";
  if (!/^[CGD][A-Z0-9]{6,20}$/.test(channel) || !/^[UW][A-Z0-9]{4,20}$/.test(user) || !/^\d{9,11}\.\d{1,8}$/.test(ts)) {
    return { kind: "ignore", reason: "malformed event" };
  }
  const threadTs = typeof ev.thread_ts === "string" && /^\d{9,11}\.\d{1,8}$/.test(ev.thread_ts) ? ev.thread_ts : ts;
  const text = String(ev.text ?? "")
    .replace(/<@[UW][A-Z0-9]+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);
  if (!text) return { kind: "ignore", reason: "empty message" };
  return { kind: "mention", mention: { eventId, teamId, eventType, channel, user, ts, threadTs, text } };
}

/** Payload of a `slack_mention` agent job (lib/agents/queue/handlers.ts). */
export interface SlackMentionJobPayload extends SlackMention {
  workspaceId: string;
  installationId: string;
  /** How many times the job waited for a busy thread. */
  deferrals?: number;
}

export interface SlackReceiveResult {
  status: number;
  body: Record<string, unknown>;
}

export interface SlackEventsDeps {
  secret: () => string;
  route: (teamId: string) => Promise<SlackInstallRow | null>;
  /** Store the receipt; false when the event id was already seen. */
  receipt: (row: { eventId: string; workspaceId: string; teamId: string; eventType: string; outcome: string }) => Promise<boolean>;
  enqueue: (payload: SlackMentionJobPayload) => Promise<{ id: string }>;
  attachJob: (workspaceId: string, eventId: string, jobId: string) => Promise<unknown>;
  workerAvailable: () => boolean;
  now: () => number;
}

export const defaultSlackEventsDeps: SlackEventsDeps = {
  secret: () => (process.env.SLACK_SIGNING_SECRET ?? "").trim(),
  route: async (teamId) => (await import("./install")).routeSlackTeam(teamId),
  receipt: async (row) => {
    const { withWorkspaceScope } = await import("@/lib/substrate/memory/rls");
    try {
      await withWorkspaceScope(row.workspaceId, (tx) => tx.slackEventReceipt.create({ data: row }));
      return true;
    } catch (err) {
      if ((err as { code?: unknown })?.code === "P2002") return false;
      throw err;
    }
  },
  enqueue: async (payload) => {
    const { enqueueAgentJob } = await import("@/lib/agents/queue/store");
    // One attempt: a retried mention could answer twice.
    return enqueueAgentJob({ workspaceId: payload.workspaceId, kind: "slack_mention", payload, maxAttempts: 1 });
  },
  attachJob: async (workspaceId, eventId, jobId) => {
    const { withWorkspaceScope } = await import("@/lib/substrate/memory/rls");
    return withWorkspaceScope(workspaceId, (tx) => tx.slackEventReceipt.update({ where: { eventId }, data: { jobId } }));
  },
  workerAvailable: () => agentWorkerMode() !== "off",
  now: () => Date.now(),
};

export async function receiveSlackEvent(
  input: { rawBody: string; signature: string | null; timestamp: string | null },
  deps: SlackEventsDeps = defaultSlackEventsDeps,
): Promise<SlackReceiveResult> {
  const secret = deps.secret();
  if (!secret) return { status: 503, body: { error: "Slack events are not configured (SLACK_SIGNING_SECRET is unset)." } };
  const sig = verifySlackSignature(secret, input.rawBody, input.timestamp, input.signature, deps.now());
  if (!sig.ok) return { status: 401, body: { error: "Invalid signature." } };

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawBody);
  } catch {
    return { status: 400, body: { error: "The body is not JSON." } };
  }
  const c = classifySlackEvent(parsed);
  if (c.kind === "url_verification") return { status: 200, body: { challenge: c.challenge } };
  if (c.kind === "ignore") return { status: 200, body: { ignored: c.reason } };

  const m = c.mention;
  const install = await deps.route(m.teamId);
  if (!install) return { status: 200, body: { ignored: "this Slack team is not connected" } };
  if (!install.enabled) return { status: 200, body: { ignored: "the Slack app is turned off for this workspace" } };

  const allowed = install.allowedUserIds.length === 0 || install.allowedUserIds.includes(m.user);
  const willQueue = allowed && deps.workerAvailable();
  const outcome = !allowed ? "refused" : willQueue ? "queued" : "ignored";
  const fresh = await deps.receipt({ eventId: m.eventId, workspaceId: install.workspaceId, teamId: m.teamId, eventType: m.eventType, outcome });
  if (!fresh) return { status: 200, body: { duplicate: true } };
  if (!allowed) return { status: 200, body: { ignored: "this Slack user may not start tasks" } };
  if (!willQueue) return { status: 200, body: { ignored: "the agent worker is off (AGENT_WORKER=off)" } };

  const job = await deps.enqueue({ ...m, workspaceId: install.workspaceId, installationId: install.id });
  await deps.attachJob(install.workspaceId, m.eventId, job.id).catch(() => undefined);
  return { status: 200, body: { queued: true } };
}
