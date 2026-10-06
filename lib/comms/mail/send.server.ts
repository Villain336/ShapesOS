// ShapesOS — Phase 18.2 (WS=comms): sending from the Mail app — through the
// EXISTING send actions only, never a new bypass:
//
//   gmail / outlook  the connector's own send_email / reply_to_message (the
//                    member's own mailbox; same live calls, MIME building and
//                    "no blind retries on a send" rule as the agent's tools)
//   crm              the CRM inbox reply (lib/crm/inbox.ts replyToThread →
//                    the messaging dispatcher: consent, quiet hours, the daily
//                    cap and the human-approval gate all still apply)
//   social           Zernio's sendInboxMessage on an account this workspace
//                    owns (Idempotency-Key: a retry never sends twice)
//
// Who decides that it goes:
//   - a person pressing Send in the Mail app — their click IS the
//     confirmation (audited as mail_sent for mailboxes; the CRM path keeps
//     its own approval gate on top);
//   - an agent — only through the mail_send / social_send_dm tools, i.e.
//     executeTool's confirmation gate with the connector's own action
//     (send_outreach_email / send_social_dm, Tier 2): it asks unless a
//     per-agent rule says auto. This module never decides that itself.

import { HttpError } from "@/lib/api/errors";
import { auditEvent } from "@/lib/auditlog";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { invokeConnection, ownConnection } from "../connectors.server";
import { sendSocialReply } from "./social.server";
import { parseThreadKey, type MailSource } from "./types";

export interface SendInput {
  /** The thread being answered (null/undefined: a new message from a mailbox). */
  threadKey?: string | null;
  /** For a new message: which mailbox (a gmail / outlook connection of the sender). */
  connectionId?: string | null;
  to?: string | null;
  cc?: string | null;
  subject?: string | null;
  body: string;
  /** CRM only: sms | email (default: the thread's last channel, else email). */
  channel?: "sms" | "email" | null;
  /** The message a reply answers (gmail / outlook; default: the thread's latest inbound). */
  replyToMessageId?: string | null;
  /** An idempotency seed (e.g. the draft id) so a double click never sends twice to Zernio. */
  idempotencySeed?: string | null;
}

export interface SendOutcome {
  source: MailSource;
  /** sent | queued (waiting on the CRM approval / quiet hours) | suppressed | mock (nothing was sent) */
  outcome: "sent" | "queued" | "suppressed" | "failed" | "mock";
  detail: string | null;
}

export interface Sender {
  workspaceId: string;
  userId: string;
  role: "viewer" | "editor" | "admin" | "owner";
  by: "person" | "agent";
}

const RANK = { viewer: 1, editor: 2, admin: 3, owner: 4 } as const;

export async function sendMail(sender: Sender, input: SendInput): Promise<SendOutcome> {
  const body = (input.body ?? "").trim();
  if (!body) throw new HttpError(400, "Write a message first.");
  const ref = input.threadKey ? parseThreadKey(input.threadKey) : null;
  if (input.threadKey && !ref) throw new HttpError(400, "That is not a mail thread.");

  // CRM conversations and social DMs are the workspace's: sending needs editor+.
  if (ref && (ref.source === "crm" || ref.source === "social") && RANK[sender.role] < RANK.editor) {
    throw new HttpError(403, "Editors and above can reply to CRM and social conversations.");
  }

  if (ref?.source === "crm") {
    const { replyToThread, markThreadRead } = await import("@/lib/crm/inbox");
    const { queueMessage } = await import("@/lib/messaging/dispatcher");
    const channel = input.channel ?? "email";
    const out = await withWorkspaceScope(sender.workspaceId, (tx) =>
      replyToThread(tx, (q) => queueMessage(q), { workspaceId: sender.workspaceId, userId: sender.userId, leadId: ref.leadId, channel, subject: input.subject ?? undefined, body }),
    );
    if (sender.by === "person") await withWorkspaceScope(sender.workspaceId, (tx) => markThreadRead(tx, { workspaceId: sender.workspaceId, userId: sender.userId, leadId: ref.leadId })).catch(() => undefined);
    return { source: "crm", outcome: out.outcome, detail: out.message.suppressionReason ?? out.message.status };
  }

  if (ref?.source === "social") {
    const r = await sendSocialReply(sender.workspaceId, ref, body, input.idempotencySeed ?? `${Date.now()}`).catch((err) => {
      throw new HttpError(err?.code === "forbidden" ? 403 : 502, err instanceof Error ? err.message : "The message was not sent.");
    });
    return { source: "social", outcome: r.mock ? "mock" : "sent", detail: r.mock ? "MOCK — the FAKE Zernio stored it; nothing reached a platform." : null };
  }

  // Gmail / Outlook: the member's own mailbox.
  const connectionId = ref && (ref.source === "gmail" || ref.source === "outlook") ? ref.connectionId : input.connectionId;
  if (!connectionId) throw new HttpError(400, "Pick the mailbox to send from.");
  const conn = await ownConnection(sender.workspaceId, sender.userId, connectionId, ["gmail", "outlook"]);
  if (!conn) throw new HttpError(404, "That mailbox is not connected to your account. Connect it in Settings → Connectors.");
  const replyTo = ref && (ref.source === "gmail" || ref.source === "outlook") ? (input.replyToMessageId ?? null) : null;
  if (ref && !replyTo) throw new HttpError(400, "Open the thread again: there is no message to reply to.");
  const res = replyTo
    ? await invokeConnection(conn, "reply_to_message", { messageId: replyTo, body }, sender)
    : await invokeConnection(conn, "send_email", { to: input.to ?? "", cc: input.cc ?? undefined, subject: input.subject ?? "", body }, sender);
  if (!res.ok) {
    const status = res.errorCode === "bad_request" ? 400 : res.errorCode === "not_connected" ? 409 : 502;
    throw new HttpError(status, res.error ?? "The message was not sent.");
  }
  const mock = res.mock === true || (res.data as { sent?: boolean } | null)?.sent === false;
  if (sender.by === "person") {
    await auditEvent({
      projectId: null,
      workspaceId: sender.workspaceId,
      actorUserId: sender.userId,
      action: "mail_sent",
      summary: `${replyTo ? "Replied" : "Sent"} from ${conn.connectorKey}${mock ? " (MOCK — nothing was sent)" : ""}: ${(input.subject ?? "").slice(0, 120)}`,
    });
  }
  return { source: conn.connectorKey as "gmail" | "outlook", outcome: mock ? "mock" : "sent", detail: mock ? "MOCK — the mailbox is not really connected; nothing was sent." : null };
}
